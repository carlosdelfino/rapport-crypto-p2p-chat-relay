# Marketing site content

Run `python3 scripts/build-marketing-site.py` from the relay directory after editing:

- `ui.json`: shared strings in the order pt-BR, en, es, fr, ar.
- `articles.json`: seven articles, canonical slugs, imagery and primary-source links.
- `reviews.json`: eight illustrative profiles; the first two use `site.review.ana` and `site.review.lucas` in `ui.json`.
- `features.html` and `api.html`: preserved feature/API descriptions from the original homepage.

The builder writes the homepage, `/blog`, seven article pages and `/suporte`, merges strings into the existing dictionaries, and adds canonical paths to the sitemap. Portuguese stays in HTML as the existing i18n engine's source language. It reuses the statistics renderer from `/stats` with `/api/stats`; no sample counters are shipped.

## Assets and provenance

- `public/images/rapport-logo.png`: supplied by the owner from `Imagens/Rapport Tecnologia/Novo Logo - 2026-2/logo 1x1.png`, copied without visual alteration.
- `public/images/carlos-delfino-stand.jpg`: supplied by the owner from `Imagens/Rapport Tecnologia/STS 2026/Carlos Delfino no Stand.jpg`.
- `public/images/editorial/*.webp`: AI-generated original editorial images and ten fictional portraits. Generated PNG originals remain in the Codex generated-images directory. WebP versions are sized for website delivery.
- Testimonials explicitly identify all names, stories and portraits as fictional. They describe illustrative uses and are not customer endorsements. Do not add review ratings or Review structured data representing them as real reviews.

The layout uses the Zakra preview as a structural reference and the supplied Rapport logo for orange/yellow branding, with requested green/brown accents. The original theme's texts and photography are not copied.

## Support

Official wallet: `0x7010A4C4c189AB421028a622e2A2e623f432d18e`.
WhatsApp supplied by the owner: `+55 85 98520-5490` (`https://wa.me/5585985205490`). Existing footer links were corrected to match.
