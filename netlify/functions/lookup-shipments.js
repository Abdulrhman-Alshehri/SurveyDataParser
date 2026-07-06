const https = require('https');

// Proxies the same live "get-list" endpoint the dashboard's "Extract Shipment"
// search box uses, queried by mobile number (search_value). Used as the Step 2
// fallback when a record's shipment number is missing/invalid and no sibling
// row in the uploaded file shares its mobile number.
exports.handler = async function (event, context) {
    console.log("Function invoked with query:", event.queryStringParameters);

    try {
        const { mobile } = event.queryStringParameters || {};
        const API_URL = process.env.STARLINKS_API_URL || 'https://starlinksapi.app/api/v1/shipments/get-list';
        const API_KEY = process.env.STARLINKS_API_KEY;

        if (!API_KEY) {
            console.error("CRITICAL: STARLINKS_API_KEY is missing in environment variables.");
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Server configuration error: Missing API Key' })
            };
        }

        if (!mobile) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Missing mobile parameter' })
            };
        }

        const url = `${API_URL}?search_value=${encodeURIComponent(mobile)}&include_completed=true`;
        console.log(`Proxying to: ${API_URL}`);

        return new Promise((resolve) => {
            const options = {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${API_KEY}`,
                    'Content-Type': 'application/json'
                }
            };

            const req = https.request(url, options, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    console.log(`Upstream Response: ${res.statusCode}`);
                    resolve({
                        statusCode: res.statusCode,
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: data
                    });
                });
            });

            req.on('error', (e) => {
                console.error("Upstream Request Error:", e);
                resolve({
                    statusCode: 502,
                    body: JSON.stringify({ error: `Upstream error: ${e.message}` })
                });
            });

            req.end();
        });
    } catch (err) {
        console.error("Unhandled Function Error:", err);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: `Internal Server Error: ${err.message}` })
        };
    }
};
