FROM nginx:1.27-alpine

# Static single-page app — no build step, just serve the files.
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html style.css app.js site.webmanifest VERSION \
     favicon.svg icon.svg favicon-16.png favicon-32.png \
     apple-touch-icon.png icon-192.png icon-512.png maskable-512.png \
     /usr/share/nginx/html/

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
