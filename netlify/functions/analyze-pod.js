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

// Arabic + Arabic Supplement. Built from an escaped string so the file's encoding
// cannot corrupt the code-point range.
const ARABIC = new RegExp('[\\u0600-\\u06FF\\u0750-\\u077F]');
const TIMESTAMP = /^\d{1,2}:\d{2}$/;
const PHONE = /\+?\d[\d\s-]{7,}\d/;

// Chat-UI furniture and clock fragments that survive the confidence filter.
// "م" and "ص" are the Arabic PM/AM markers and leak out of localized timestamps.
const NOISE_WORDS = new Set([
    'edited', 'pm', 'am', 'v', '//', '...', 'message', 'volte', 'lte',
    'م', // Arabic "م" = PM
    'ص'  // Arabic "ص" = AM
]);

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
        if (TIMESTAMP.test(t)) return false;
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
    return { text, isArabic, x0: box.x0, y0: box.y0, x1: box.x1 };
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

    const phones = [];
    const body = [];
    const seen = new Set();
    lines.forEach(l => {
        const m = l.text.match(PHONE);
        if (m && !l.isArabic) {
            const p = m[0].replace(/\s+/g, ' ').trim();
            if (!phones.includes(p)) phones.push(p);
            return;
        }
        // WhatsApp renders a quoted reply above the response, duplicating the text.
        if (seen.has(l.text)) return;
        seen.add(l.text);
        body.push(l);
    });

    const out = [];
    if (isScreenshot) {
        out.push('Chat screenshot. Conversation (top to bottom):');
        body.forEach(l => {
            // Chat apps right-align the phone owner's own messages. The POD is shot on
            // the courier's handset, so right-aligned text is the courier speaking.
            const centre = (l.x0 + l.x1) / 2;
            const who = imgWidth && centre > imgWidth / 2 ? 'courier' : 'customer';
            out.push(`  [${who}] ${l.text}`);
        });
        if (!body.length) out.push('  (no legible text)');
    } else {
        const scene = Object.keys(tags)
            .filter(n => tags[n] >= SCREENSHOT_CONF_MIN && n !== 'text')
            .sort((a, b) => tags[b] - tags[a])
            .join(', ');
        out.push(`Photo (${scene || 'no clear scene'}).`);
        if (body.length) {
            out.push('Text found:');
            body.forEach(l => out.push(`  ${l.text}`));
        } else {
            out.push('No legible text.');
        }
    }
    if (phones.length) out.push('Contact seen: ' + phones.join('; '));

    return { summary: out.join('\n'), kind: isScreenshot ? 'screenshot' : 'photo' };
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
        const { summary, kind } = summarize(azure);
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: true, kind, summary })
        };
    } catch (err) {
        console.error('Unhandled Function Error:', err);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: `Internal Server Error: ${err.message}` })
        };
    }
};
