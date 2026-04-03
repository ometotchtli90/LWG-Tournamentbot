FROM nginx:alpine

COPY leaderboard/ /usr/share/nginx/html/leaderboard/
COPY leaderboard/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY docker-entrypoint-extra.sh /docker-entrypoint.d/40-htpasswd.sh
RUN chmod +x /docker-entrypoint.d/40-htpasswd.sh

EXPOSE 80
