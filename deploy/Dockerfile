# Arc platform container — used by the AWS (ECS Fargate) deployment.
# The Lightsail box keeps running from git until cutover; this file is inert there.
# Base comes from AWS's public mirror, not Docker Hub: docker.io throttles and
# resets GitHub's shared runners (hit on deploy #4), public.ecr.aws does not.
# Same official image, same tags.
FROM public.ecr.aws/docker/library/node:22-slim

# curl for the container health check; ca-certificates for outbound TLS (CMS, AWS, Twilio, OSM)
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Amazon's RDS certificate bundle, so the app can VERIFY the database's TLS
# cert (PGSSLROOTCERT points here in the task definition). Baked in at build:
# a runtime download would put the registry/CDN on the boot path.
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/rds-global-bundle.pem
RUN chmod 0444 /app/rds-global-bundle.pem

# Install deps first so code changes don't bust the npm layer.
# postinstall runs `npm --prefix client install`, so client/package*.json must be present.
# NODE_ENV=production is set AFTER npm ci, deliberately: the app runs through
# tsx, which is a devDependency — with production set first, npm ci omitted it
# and every container boot re-downloaded tsx from the npm registry (seen live
# on deploy #5's logs). Runtime still gets NODE_ENV=production via ENV below.
COPY package.json package-lock.json ./
COPY client/package.json client/package-lock.json ./client/
RUN npm ci
ENV NODE_ENV=production

COPY . .

# Data (SQLite era) and uploads live on a mounted volume until S3/RDS stages land.
ENV TRILOGY_DATA_DIR=/data
VOLUME /data

# Which commit this image contains. .dockerignore excludes .git, so the server
# cannot ask git once it is in here — the build passes the SHA in instead and
# /api/health reports it back. Declared after COPY so it never busts the npm layer.
ARG GIT_COMMIT=""
ENV GIT_COMMIT=$GIT_COMMIT

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD curl -fsS http://localhost:4000/api/health || exit 1

# No build step — tsx runs TypeScript directly; client/dist is committed.
CMD ["npx", "tsx", "server/index.ts"]
