# shar8-template: {{TEMPLATE_VERSION}}
[Unit]
Description=shar8 agent tick
[Service]
Type=oneshot
Environment="PATH={{PATH}}"
ExecStart=/bin/sh "{{LOADER}}" tick
StandardOutput=journal
StandardError=journal
