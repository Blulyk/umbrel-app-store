#!/bin/bash
# Generate a secure local auth token if not already generated, or just rely on Umbrel APP_PASSWORD.
# In this case we mapped APP_PASSWORD directly in the docker-compose so exports.sh is not strictly necessary for token,
# but it's good practice for Umbrel apps to have it.

export EXPORTS_TEST="ready"
