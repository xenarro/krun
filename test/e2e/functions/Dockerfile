ARG CURL_IMAGE
FROM ${CURL_IMAGE}
ARG SCENARIO
COPY --chmod=0555 common.sh /common.sh
COPY --chmod=0555 ${SCENARIO}.sh /function.sh
ENTRYPOINT ["/bin/sh", "/function.sh"]
