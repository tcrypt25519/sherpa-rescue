.DEFAULT_GOAL: docker

.PHONY: docker

IMAGE_NAME ?= tcrypt/sherpa-rescue

docker:
	docker build -f docker/Dockerfile -t "$(IMAGE_NAME)" .

