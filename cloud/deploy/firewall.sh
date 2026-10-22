#!/usr/bin/env bash
# Правила для сети облачных сред (интерфейс br-codary): контейнеры выходят в интернет, но не видят сервер и соседей.
# Идемпотентно: можно запускать повторно (запускается при старте системы юнитом codary-cloud-fw.service).
set -euo pipefail
BR=${1:-br-codary}
add() { iptables -C "$@" 2>/dev/null || iptables -I "$@"; }
# не ходить в частные сети, на другие контейнеры и на служебные адреса облака
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10; do add DOCKER-USER -i "$BR" -d "$net" -j DROP; done
# спам и почтовые рассылки
add DOCKER-USER -i "$BR" -p tcp -m multiport --dports 25,465,587 -j DROP
# на сам сервер (SSH, базы, панели) контейнеры не ходят; ответы на запросы nginx и менеджера пропускаем
add INPUT -i "$BR" -j DROP
add INPUT -i "$BR" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
echo "правила для $BR применены"
