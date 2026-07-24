FROM nginx:1.27-alpine

# Static single-page app — no build step, just serve the files.
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html style.css app.js /usr/share/nginx/html/

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
