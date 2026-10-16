# Barcode tag checker

Barcode tag checker compares barcode tag artwork (PDF, JPG or PNG) with a PO barcode Excel file. It reports mismatched tag fields, invalid or missing barcodes, duplicate tags, and Excel rows without a tag. All processing happens in your browser; your files are not uploaded.

## Live site

After GitHub Pages is enabled, the site URL follows this format:

`https://<user>.github.io/<repo>/`

## Change the checking rules

Edit `core.js` to change the rules. `FIELD_MAP` maps tag labels to Excel columns, and `STATIC_TEXT` contains the fixed wording expected on every tag. Commit and push the changes to `main` to publish them.

## Local preview

The configured Codespace runs `npx --yes http-server -p 8080 -c-1 .` when attached. Open port 8080 to preview the page.
