FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS build

WORKDIR /src
RUN apk add --no-cache git

COPY go.mod go.sum ./
RUN go mod download

COPY . .

ARG VERSION=""
ARG TARGETOS TARGETARCH
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath \
    -ldflags="-s -w -X slock/internal/version.override=${VERSION}" \
    -o /out/slock ./cmd/slock

FROM alpine:3.21

RUN apk add --no-cache ca-certificates tzdata \
    && adduser -D -u 10001 slock \
    && mkdir -p /data/attachments \
    && chown -R slock:slock /data

COPY --from=build /out/slock /usr/local/bin/slock

USER slock
WORKDIR /data
VOLUME /data

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/slock"]
