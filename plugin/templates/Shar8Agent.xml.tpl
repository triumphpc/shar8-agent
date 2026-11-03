<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>shar8 agent tick (shar8-template: {{TEMPLATE_VERSION}})</Description></RegistrationInfo>
  <Triggers><TimeTrigger>
    <Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
    <StartBoundary>2000-01-01T00:00:00</StartBoundary><Enabled>true</Enabled>
  </TimeTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>{{USER_SID}}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>false</StartWhenAvailable><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>false</Hidden>
    <ExecutionTimeLimit>{{EXEC_TIME_LIMIT}}</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author"><Exec>
    <Command>wscript.exe</Command>
    <Arguments>//B //NoLogo //E:JScript "{{LAUNCH_JS}}" "{{NODE}}" "{{SHIM}}" tick</Arguments>
  </Exec></Actions>
</Task>
