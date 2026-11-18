#!/bin/sh
printf 'ran\n' >> "${0%/*}/../../bootstrap.log"
printf 'BOOTSTRAP RAN\n'
exit 0
