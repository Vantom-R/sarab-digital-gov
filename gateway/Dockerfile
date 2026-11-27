# Stage 1: build the web portal
FROM node:24-alpine AS portal
WORKDIR /portal
COPY portal/package.json portal/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY portal/ ./
RUN npm run build

# Stage 2: nginx serving the portal and proxying the public APIs
FROM nginx:1.28-alpine
COPY gateway/nginx.conf /etc/nginx/nginx.conf
COPY gateway/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=portal /portal/dist /usr/share/nginx/html
COPY gateway/openapi/ /usr/share/nginx/openapi/
USER nginx
EXPOSE 8080
