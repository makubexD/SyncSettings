# Job agent: runs each \\host.lan\Data\jobs\<id>.job in a fresh copy of the repo, writes <id>.out and <id>.exit.
$share = '\\host.lan\Data'
$jobs = Join-Path $share 'jobs'
$work = 'C:\work\repo'
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')

# The host writes job files straight to disk, behind the SMB server's back, so the client's cached
# folder listing is never refreshed and a new job can go unseen for minutes. No caching.
Set-SmbClientConfiguration -DirectoryCacheLifetime 0 -FileInfoCacheLifetime 0 -FileNotFoundCacheLifetime 0 `
    -Confirm:$false -ErrorAction SilentlyContinue

while (-not (Test-Path $jobs)) { Start-Sleep -Seconds 2 }
[IO.File]::WriteAllText((Join-Path $share 'ready'), (Get-Date -Format o))

while ($true) {
    foreach ($job in @(Get-ChildItem -Path $jobs -Filter '*.job' -ErrorAction SilentlyContinue)) {
        $id = $job.BaseName
        $running = Join-Path $jobs "$id.running"
        try { Move-Item -LiteralPath $job.FullName -Destination $running -ErrorAction Stop } catch { continue }
        $out = Join-Path $jobs "$id.out"
        $code = 1
        try {
            if (Test-Path $work) { Remove-Item -LiteralPath $work -Recurse -Force }
            # No .git: thousands of small files over SMB cost minutes, and the cases make their own repos.
            # /A-:RHS: the share shows dot-files as Hidden, and Windows refuses to rewrite a hidden file.
            robocopy (Join-Path $share 'repo') $work /MIR /MT:16 /A-:RHS /NFL /NDL /NJH /NJS /NP /XD .git node_modules dist | Out-Null
            # -EncodedCommand: Start-Process joins arguments without quoting, so a plain -Command loses quotes.
            # No progress records: with stderr redirected they arrive as CLIXML noise.
            $cmd = "`$ProgressPreference = 'SilentlyContinue'`n" + [IO.File]::ReadAllText($running)
            $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cmd))
            $p = Start-Process -FilePath 'powershell.exe' -WorkingDirectory $work -NoNewWindow -Wait -PassThru `
                -RedirectStandardOutput $out -RedirectStandardError "$out.err" `
                -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded)
            $code = $p.ExitCode
            Get-Content -LiteralPath "$out.err" -Raw -ErrorAction SilentlyContinue | Add-Content -LiteralPath $out
            Remove-Item -LiteralPath "$out.err" -ErrorAction SilentlyContinue
        } catch {
            Add-Content -LiteralPath $out -Value "agent: $_"
            Add-Content -LiteralPath (Join-Path $share 'agent.log') `
                -Value "$id $($_.Exception.GetType().FullName): $_ $($_.InvocationInfo.PositionMessage)"
        }
        Remove-Item -LiteralPath $running -ErrorAction SilentlyContinue
        [IO.File]::WriteAllText((Join-Path $jobs "$id.exit"), "$code")
    }
    Start-Sleep -Seconds 1
}
