#!/bin/bash
# Double-click this file on a Mac to get the newest version. The data folder is not touched.
cd "$(dirname "$0")"
node update.js
read -n 1 -s -r -p "Press any key to close."
