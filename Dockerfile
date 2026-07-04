FROM nginx:alpine

# Copy all static assets into nginx serve dir
COPY --chmod=644 index.html /usr/share/nginx/html/
COPY --chmod=644 app.js /usr/share/nginx/html/
COPY --chmod=644 styles.css /usr/share/nginx/html/
COPY --chmod=644 rules.default.json /usr/share/nginx/html/

# Custom nginx config to support sub-path deployment via /pgr
COPY --chmod=644 nginx-default.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
