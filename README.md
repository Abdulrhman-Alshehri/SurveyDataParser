# Shipment Survey Parser

A web-based tool designed to parse customer survey data (exported from Excel/CSV) and enrich it with live shipment tracking details using the Shipsy API.

## 🚀 Features

- **Drag & Drop Upload**: Support for `.xlsx` and `.csv` files.
- **Automated Parsing**: Uses Regular Expressions to extract survey responses (CSAT, NPS, Comments) from unstructured text fields.
- **Data Enrichment**: Automatically fetches shipment details (Worker Name, Hub Code, Delivery Time) for each record via a secure backend proxy.
- **Missing Shipment Linkage**: Detects records whose "Job Done Name" has no valid shipment number (e.g. unresolved `{{track_number}}` templates) and links them to the customer's other shipments using the "User Channel ID" (mobile number). Each record is tagged with a Match Status (`ok`, `found`, or `no_shipment_found`) and never has a shipment number guessed for it.
- **Delivery Date Filter**: A date-range picker on the results page removes shipments whose delivery date falls outside the selected range from both the table and the export.
- **Excel Export**: Download the fully processed and enriched dataset as a clean Excel file.
- **Responsive Design**: Modern UI with real-time progress indicators.

## 🛠️ Tech Stack

- **Frontend**: HTML5, Vanilla JavaScript, CSS (Custom "Euclid Circular B" font support).
- **Libraries**: [SheetJS (xlsx)](https://sheetjs.com/) for client-side Excel processing.
- **Backend**: Netlify Functions (Node.js) for secure API proxying.
- **API Integration**: Connects to Shipsy API.

## 📂 Project Structure

```
├── index.html                   # Main application (UI + logic)
├── xlsx.full.min.js             # SheetJS library
├── netlify/
│   └── functions/
│       └── track.js             # Serverless function to proxy Shipsy API requests
├── font/                        # Custom font files
├── logo.png                     # Application logo
└── .env                         # Environment variables (local dev)
```

## ⚙️ Setup & Installation

### Prerequisites

- [Node.js](https://nodejs.org/) (for local development)
- [Netlify CLI](https://docs.netlify.com/cli/get-started/) (`npm install netlify-cli -g`)

### Local Development

1. **Clone or Navigate to the directory**:
   ```bash
   cd path/to/project
   ```

2. **Configure Environment Variables**:
   Create a `.env` file in the root directory and add your Shipsy credentials:
   ```env
   SHIPSY_API_URL=https://api.shipsy.in/api/client/track
   SHIPSY_API_KEY=your_actual_api_key_here
   ```

3. **Start the Development Server**:
   Use Netlify Dev to run both the frontend and the backend function locally.
   ```bash
   netlify dev
   ```
   The app will typically open at `http://localhost:8888`.

## 📦 Deployment

This project is configured for **Netlify**.

1. **Push to Git**: Ensure your code is in a Git repository.
2. **Connect to Netlify**: Create a new site from Git.
3. **Set Environment Variables**: In the Netlify Dashboard (Site Settings > Build & deploy > Environment), add:
    - `SHIPSY_API_URL`
    - `SHIPSY_API_KEY`
4. **Deploy**: Trigger a deployment.

## 📝 Usage Guide

1. **Prepare Data**: Ensure your Input Excel file has a column with survey text strings containing patterns like `Survey for shipment: ... ||| ...`.
2. **Upload**: Drag the file into the upload zone.
3. **Process**: The tool will parse the text and automatically start fetching tracking data for each shipment number.
4. **Download**: Once processing is complete, click **Download Results** to get the final Excel report.

## ⚠️ Troubleshooting

- **"Missing API Key"**: Ensure `SHIPSY_API_KEY` is set in your environment variables.
- **CORS Errors**: The Netlify function helps avoid CORS issues by proxying requests. Ensure you are hitting the local function (`/.netlify/functions/track`) and not the external API directly from the browser.
