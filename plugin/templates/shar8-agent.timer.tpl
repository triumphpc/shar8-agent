# shar8-template: {{TEMPLATE_VERSION}}
[Unit]
Description=shar8 agent timer
[Timer]
OnActiveSec=1s
OnStartupSec=60s
OnUnitActiveSec=60s
AccuracySec=1s
Unit=shar8-agent.service
[Install]
WantedBy=timers.target
