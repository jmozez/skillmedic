#!/usr/bin/env python3
import sys
print(open(sys.argv[1], "rb").read()[:100])
