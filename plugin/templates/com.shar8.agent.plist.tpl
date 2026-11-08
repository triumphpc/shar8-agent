<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.shar8.agent</string>
  <key>Shar8TemplateVersion</key><integer>{{TEMPLATE_VERSION}}</integer>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>{{LOADER}}</string><string>tick</string></array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><false/>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>{{PATH}}</string></dict>
  <key>StandardOutPath</key><string>{{LOGDIR}}/tick.log</string>
  <key>StandardErrorPath</key><string>{{LOGDIR}}/tick.log</string>
  <key>ProcessType</key><string>Background</string>
  <key>AbandonProcessGroup</key><true/>
</dict></plist>
