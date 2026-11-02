#!/bin/sh
set -eu

mkdir -p /keys /run/sshd /home/tester/.ssh /srv/app/data
if [ ! -f /keys/id_ed25519 ]; then
  ssh-keygen -t ed25519 -N '' -f /keys/id_ed25519
fi
cp /keys/id_ed25519.pub /home/tester/.ssh/authorized_keys
chown -R tester:tester /home/tester/.ssh
chmod 700 /home/tester/.ssh
chmod 600 /home/tester/.ssh/authorized_keys
printf 'hello from remote\n' > /srv/app/config
printf 'remote data\n' > /srv/app/data/record.txt
ssh-keygen -A
exec /usr/sbin/sshd -D -e
