# Garage object storage, repackaged on Alpine so the init script has a shell.
# The official dxflrs/garage image is distroless (binary only, no /bin/sh),
# which can't run docker/garage/init.sh.
FROM dxflrs/garage:v1.0.1 AS upstream

FROM alpine:3.20
COPY --from=upstream /garage /garage
ENTRYPOINT ["/garage"]
