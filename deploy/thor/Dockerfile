# VLAEval image for Thor: the openpi Thor image with the repo's transformers_replace baked in, so evaluation
# containers can run as the SSH user (no root-only copy into site-packages at start-up).
# Build on Thor from the evaluation repo:
#   docker build -t openpi-pi0.5:vlaeval -f Dockerfile ~/kgs/pi05_rby1/src/openpi/models_pytorch/transformers_replace
# Rebuild whenever that repo's transformers_replace changes.
FROM openpi-pi0.5:l4t-jp7.2
COPY . /usr/local/lib/python3.12/dist-packages/transformers/
