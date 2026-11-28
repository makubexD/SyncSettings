#!/bin/sh
printf 'ran %s\n' "${MKSYNC_SETUP_EXISTING-}" >> "${0%/*}/../../bootstrap.log"
printf 'BOOTSTRAP RAN\n'
exit 0
