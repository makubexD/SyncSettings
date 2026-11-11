# Run at every logon: take the agent from the host's repo, so a fix to it needs no change in the guest.
$source = '\\host.lan\Data\repo\tests\windows-vm\oem\agent.ps1'
while (-not (Test-Path $source)) { Start-Sleep -Seconds 2 }
Copy-Item -LiteralPath $source -Destination 'C:\OEM\agent.run.ps1' -Force
& 'C:\OEM\agent.run.ps1'
