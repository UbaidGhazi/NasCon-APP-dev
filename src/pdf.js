'use strict';

const { execSync } = require('child_process');

/**
 * Generate a valid PDF buffer containing the receipt details.
 * Must start with %PDF and extracted text must contain order_id and
 * formatted total: "PKR 4500.00" (two decimals, no thousands separator).
 */
function generatePdfReceipt({ order_id, total_minor }) {
  const formattedTotal = `PKR ${(total_minor / 100).toFixed(2)}`;

  // Try wkhtmltopdf if available
  try {
    const html = `<!DOCTYPE html><html><body><h1>Receipt</h1><p>Order ID: ${order_id}</p><p>Total: ${formattedTotal}</p></body></html>`;
    const pdfBuf = execSync('wkhtmltopdf -q - -', {
      input: html,
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 3000,
    });
    if (pdfBuf && pdfBuf.slice(0, 4).toString() === '%PDF') {
      return pdfBuf.toString('base64');
    }
  } catch (_) {
    // Fall back to pure JS standard PDF generation
  }

  // Pure JavaScript standard compliant PDF generator
  const content = `BT /F1 14 Tf 50 750 Td (Order ID: ${order_id}) Tj 0 -30 Td (Total: ${formattedTotal}) Tj ET`;
  const streamLength = Buffer.byteLength(content, 'utf8');

  const lines = [
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj',
    `4 0 obj << /Length ${streamLength} >> stream\n${content}\nendstream\nendobj`,
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
  ];

  let offset = 0;
  const offsets = [];
  let body = '';
  for (const line of lines) {
    offsets.push(offset);
    body += line + '\n';
    offset = Buffer.byteLength(body, 'utf8');
  }

  const xrefStart = Buffer.byteLength(body, 'utf8');
  let xref = `xref\n0 6\n0000000000 65535 f \n`;
  for (let i = 1; i <= 5; i++) {
    xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  const trailer = `trailer << /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  const fullPdf = body + xref + trailer;

  return Buffer.from(fullPdf, 'utf8').toString('base64');
}

module.exports = { generatePdfReceipt };
