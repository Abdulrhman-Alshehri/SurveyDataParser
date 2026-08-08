const https = require('https');

// Proxies a single proof-of-delivery image to Azure AI Vision (Image Analysis 4.0)
// and returns a human-readable summary of what the image contains.
//
// The summary is assembled deterministically from the Azure response — there is no
// model reasoning here. The operator compares the summary against the shipment's NDR
// reason themselves, so this function's job is to report faithfully, not to judge.
//
// Only `tags` and `read` are requested. `caption`/`denseCaptions` are unavailable in
// this region, and `objects`/`people` were measured returning confident nonsense on
// these images (a "door" at 0.58 on a chat screenshot), so they are not used.

const AZURE_FEATURES = 'tags,read';
const AZURE_API_VERSION = '2024-02-01';

// Only Shipsy's POD bucket may be proxied. Without this the function would fetch
// any URL a caller supplied on Azure's behalf.
const ALLOWED_IMAGE_HOST = 'shipsy-img.s3.us-west-2.amazonaws.com';

// Azure emits low-confidence guesses for compression artefacts; below this the text
// is reliably junk ("4770" at 0.08 off a phone status bar).
const WORD_CONF_MIN = 0.70;

// Fraction of image height occupied by the phone's own status bar (clock, battery,
// carrier). Text found entirely inside this band is never part of the conversation.
const STATUS_BAR_FRAC = 0.04;

// A tag confidence high enough to trust the screenshot/photo classification.
const SCREENSHOT_CONF_MIN = 0.60;

// Wrapped lines inside one chat bubble sit closer together than separate messages.
// Expressed as a multiple of the median line height.
const BUBBLE_GAP_RATIO = 0.9;

// OCR frequently clips the trailing digits of a phone number, so short candidates are
// still worth keeping — the caller decides whether a partial counts as a match. The
// Saudi prefix requirement is what keeps shipment numbers out (S0007053683 normalises
// to 7053683, which is the right length but the wrong shape).
const PHONE_MIN_DIGITS = 7;
const PHONE_MAX_DIGITS = 15;
const SAUDI_PHONE_START = /^(966|5)/;

// Arabic + Arabic Supplement. Built from an escaped string so the file's encoding
// cannot corrupt the code-point range.
const ARABIC = new RegExp('[\\u0600-\\u06FF\\u0750-\\u077F]');
// Arabic *letters* only. The full Arabic block contains the ٠-٩ digits, so matching
// it wholesale would treat a bare Arabic number as though it were words.
const HAS_LETTERS = new RegExp('[A-Za-z\\u0620-\\u064A\\u0671-\\u06D3]');
const ARABIC_INDIC = new RegExp('[\\u0660-\\u0669]', 'g');
const EXT_ARABIC_INDIC = new RegExp('[\\u06F0-\\u06F9]', 'g');

// Automated carrier notifications. They appear verbatim in nearly every POD and say
// nothing about whether the delivery actually failed.
const BOILERPLATE = [
    /you can track your/i,
    /shipment here/i,
    /starlinks-me\.com/i,
    /^tracking$/i,
    /thank you for/i,
    /choosing starlinks/i,
    /keep the payment/i,
    /ready for collection/i,
    /if applicable/i,
    /please confirm your regist/i,
    /share your saudi/i,
    /address, or share/i,
    /\?search=/i,
    /\/tracking/i,
    /^send address/i,
    /معك شركة ستارلينكس/,
    /سيتم اليوم استلام الشحنة/,
    /المرتجعة الخاصة بك/,
    /عنوان الاستلام المسجل/,
    /^ارسل العنوان$/
];

// Chat-app furniture: input placeholders, sender labels, expanders, tombstones.
const UI_CHROME = [
    /^الرسالة$/,
    /^أنت$/,
    /قراءة المزيد/,
    /لقد حذفت/,
    /يستمر التطبيق/,
    /معلومات عن التطبيق/,
    /^إغلاق/,
    /^edited$/i
];

// Call activity is not conversation, but it is evidence: repeated missed calls speak
// directly to a "NO RESPONSE" claim. Counted separately rather than inlined.
const CALL_EVENTS = [
    /مكالمة صوتية فائتة/,
    /مكالمة فيديو فائتة/,
    /مكالمة صوتية/,
    /مكالمة فيديو/,
    /فشل الاتصال/,
    /إعادة المحاولة/,
    /اضغط لمعاودة الاتصال/,
    /missed (voice|video) call/i
];

const NOISE_WORDS = new Set([
    'edited', 'pm', 'am', 'v', '//', '...', 'message', 'volte', 'lte',
    'م', // Arabic "م" = PM
    'ص'  // Arabic "ص" = AM
]);

// Arabic-Indic numerals render as ٠-٩, which JavaScript's \d does not match. Every
// numeric test below runs on the ASCII form so Arabic clocks are recognised too.
function toAsciiDigits(s) {
    return String(s)
        .replace(ARABIC_INDIC, d => String(d.charCodeAt(0) - 0x0660))
        .replace(EXT_ARABIC_INDIC, d => String(d.charCodeAt(0) - 0x06F0));
}

function digitsOnly(s) {
    return toAsciiDigits(s).replace(/\D/g, '');
}

// True for clock readings in either numeral system, with or without a trailing
// day marker ("11:44 /7") or meridiem.
function isTimestamp(text) {
    const t = toAsciiDigits(text).replace(/\s*\/\s*\d+\s*$/, '').trim();
    return /^\d{1,2}\s*[:.]\s*\d{1,2}$/.test(t);
}

// Fragments with no letters in any script carry nothing a reviewer can act on.
function isContentless(text) {
    return !HAS_LETTERS.test(text);
}

function matchesAny(patterns, text) {
    return patterns.some(re => re.test(text));
}

function polyBox(poly) {
    const xs = poly.map(p => p.x);
    const ys = poly.map(p => p.y);
    return {
        x0: Math.min(...xs), y0: Math.min(...ys),
        x1: Math.max(...xs), y1: Math.max(...ys)
    };
}

// Filters one OCR line down to its meaningful words and rebuilds it in reading order.
// Returns null when nothing survives.
function cleanLine(line, imgHeight) {
    const box = polyBox(line.boundingPolygon || []);
    if (box.y1 < imgHeight * STATUS_BAR_FRAC) return null;

    const kept = (line.words || []).filter(w => {
        const t = (w.text || '').trim();
        if (!t) return false;
        if ((w.confidence || 0) < WORD_CONF_MIN) return false;
        if (isTimestamp(t)) return false;
        if (NOISE_WORDS.has(t.toLowerCase())) return false;
        // Stray single Latin glyphs are icon misreads (O, C, A, e).
        if (t.length <= 1 && !ARABIC.test(t)) return false;
        return true;
    });
    if (!kept.length) return null;

    const isArabic = kept.some(w => ARABIC.test(w.text));
    // Arabic reads right-to-left, so descending x is the correct word order.
    kept.sort((a, b) => {
        const ax = polyBox(a.boundingPolygon).x0;
        const bx = polyBox(b.boundingPolygon).x0;
        return isArabic ? bx - ax : ax - bx;
    });

    const text = kept.map(w => w.text).join(' ').trim();
    if (!text) return null;
    return { text, isArabic, x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1 };
}

// Merges wrapped fragments of the same chat bubble back into one message. Without
// this a single sentence arrives as three lines and can be attributed to both sides.
function mergeBubbles(lines, imgWidth) {
    if (!lines.length) return [];

    const heights = lines.map(l => l.y1 - l.y0).sort((a, b) => a - b);
    const medianHeight = heights[Math.floor(heights.length / 2)] || 1;
    const maxGap = medianHeight * BUBBLE_GAP_RATIO;

    const sideOf = l => (imgWidth && (l.x0 + l.x1) / 2 > imgWidth / 2) ? 'courier' : 'customer';

    const bubbles = [];
    lines.forEach(line => {
        const side = sideOf(line);
        const prev = bubbles[bubbles.length - 1];
        if (prev && prev.side === side && (line.y0 - prev.y1) <= maxGap) {
            prev.text += ' ' + line.text;
            prev.y1 = line.y1;
            return;
        }
        bubbles.push({ text: line.text, side, y0: line.y0, y1: line.y1, isArabic: line.isArabic });
    });
    return bubbles;
}

function summarize(azure) {
    const meta = azure.metadata || {};
    const imgWidth = meta.width || 0;
    const imgHeight = meta.height || 0;

    const tags = {};
    ((azure.tagsResult || {}).values || []).forEach(t => { tags[t.name] = t.confidence; });
    const isScreenshot = (tags.screenshot || 0) >= SCREENSHOT_CONF_MIN;

    const lines = [];
    ((azure.readResult || {}).blocks || []).forEach(block => {
        (block.lines || []).forEach(line => {
            const c = cleanLine(line, imgHeight);
            if (c) lines.push(c);
        });
    });
    lines.sort((a, b) => a.y0 - b.y0); // top to bottom

    const bubbles = mergeBubbles(lines, imgWidth);

    const phones = [];
    const kept = [];
    const seen = new Set();
    let callEvents = 0;

    bubbles.forEach(b => {
        const text = b.text.trim();

        // Phone numbers are pulled out rather than shown as speech. Anything too short
        // is a truncated read or a shipment number, not a contact.
        const digits = digitsOnly(text);
        if (!ARABIC.test(text) && /^[+\d\s()-]+$/.test(text)) {
            const trimmed = digits.replace(/^0+/, '');
            if (trimmed.length >= PHONE_MIN_DIGITS && trimmed.length <= PHONE_MAX_DIGITS
                && SAUDI_PHONE_START.test(trimmed)) {
                if (!phones.includes(trimmed)) phones.push(trimmed);
            }
            return; // numeric-only bubble: never conversation
        }

        if (matchesAny(CALL_EVENTS, text)) { callEvents++; return; }
        if (matchesAny(UI_CHROME, text)) return;
        if (matchesAny(BOILERPLATE, text)) return;
        if (isTimestamp(text) || isContentless(text)) return;
        if (seen.has(text)) return; // quoted replies repeat the original
        seen.add(text);
        kept.push(b);
    });

    // A phone number can also appear inline inside a normal message.
    kept.forEach(b => {
        const m = toAsciiDigits(b.text).match(/\+?\d[\d\s-]{7,}\d/);
        if (!m) return;
        const trimmed = m[0].replace(/\D/g, '').replace(/^0+/, '');
        if (trimmed.length >= PHONE_MIN_DIGITS && trimmed.length <= PHONE_MAX_DIGITS
            && SAUDI_PHONE_START.test(trimmed) && !phones.includes(trimmed)) phones.push(trimmed);
    });

    const customerLines = kept.filter(b => b.side === 'customer').map(b => b.text);
    const out = [];
    let scene = '';

    if (isScreenshot) {
        if (kept.length) {
            out.push('Chat screenshot. Conversation (top to bottom):');
            kept.forEach(b => out.push(`  [${b.side}] ${b.text}`));
        } else {
            out.push('Chat screenshot with no readable conversation.');
        }
    } else {
        scene = Object.keys(tags)
            .filter(n => tags[n] >= SCREENSHOT_CONF_MIN && n !== 'text')
            .sort((a, b) => tags[b] - tags[a])
            .join(', ');
        out.push(`Photo (${scene || 'no clear scene'}).`);
        if (kept.length) {
            out.push('Text found:');
            kept.forEach(b => out.push(`  ${b.text}`));
        } else {
            out.push('No legible text.');
        }
    }

    // Repeated call attempts are direct evidence for or against a "no response" claim.
    if (callEvents) {
        out.push(`Call activity: ${callEvents} missed or failed call event(s).`);
    }
    if (phones.length) out.push('Contact seen: ' + phones.join('; '));

    return {
        summary: out.join('\n'),
        kind: isScreenshot ? 'screenshot' : 'photo',
        customerLines,
        // The customer's closing line is usually what settles the row.
        lastCustomerLine: customerLines.length ? customerLines[customerLines.length - 1] : '',
        scene,
        phones,
        callEvents,
        readable: kept.length
    };
}

function postToAzure(endpoint, key, imageUrl) {
    return new Promise((resolve) => {
        const base = endpoint.replace(/\/+$/, '');
        const url = `${base}/computervision/imageanalysis:analyze`
            + `?api-version=${AZURE_API_VERSION}&features=${AZURE_FEATURES}`;
        const payload = JSON.stringify({ url: imageUrl });

        const req = https.request(url, {
            method: 'POST',
            headers: {
                'Ocp-Apim-Subscription-Key': key,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        }, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => resolve({
                statusCode: res.statusCode,
                retryAfter: res.headers['retry-after'],
                body: data
            }));
        });

        req.on('error', e => resolve({ statusCode: 0, body: '', error: e.message }));
        req.write(payload);
        req.end();
    });
}

exports.handler = async function (event) {
    try {
        const { url: imageUrl } = event.queryStringParameters || {};
        const ENDPOINT = process.env.AZURE_CV_ENDPOINT;
        const KEY = process.env.AZURE_CV_KEY;

        if (!KEY || !ENDPOINT) {
            console.error('CRITICAL: AZURE_CV_KEY or AZURE_CV_ENDPOINT missing in environment variables.');
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Server configuration error: Missing Azure credentials' })
            };
        }

        if (!imageUrl) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing url parameter' }) };
        }

        let parsed;
        try {
            parsed = new URL(imageUrl);
        } catch (e) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Malformed url parameter' }) };
        }
        if (parsed.protocol !== 'https:' || parsed.hostname !== ALLOWED_IMAGE_HOST) {
            return { statusCode: 400, body: JSON.stringify({ error: 'url host not allowed' }) };
        }

        const res = await postToAzure(ENDPOINT, KEY, imageUrl);

        if (res.statusCode === 429) {
            return {
                statusCode: 429,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'rate_limited', retryAfter: Number(res.retryAfter) || 60 })
            };
        }

        if (res.statusCode !== 200) {
            let detail = res.error || res.body;
            let unreachable = false;
            try {
                const parsedErr = JSON.parse(res.body);
                detail = (parsedErr.error && parsedErr.error.message) || detail;
                // Azure reports an inaccessible S3 object as a 400 naming the status code.
                unreachable = /can not be accessed/i.test(detail);
            } catch (e) { /* keep raw body as the detail */ }
            console.warn(`Azure analyze failed (${res.statusCode}) for ${imageUrl}: ${detail}`);
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ok: false, unreachable, detail: String(detail).slice(0, 300) })
            };
        }

        const azure = JSON.parse(res.body);
        const result = summarize(azure);
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.assign({ ok: true }, result))
        };
    } catch (err) {
        console.error('Unhandled Function Error:', err);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: `Internal Server Error: ${err.message}` })
        };
    }
};
