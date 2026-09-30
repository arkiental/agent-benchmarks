Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
try {
    if ($env:BENCH_CONNECTOR_IPC -ne '1' -or -not [Console]::IsOutputRedirected) { throw 'The vault reader is an internal connector pipe, not an interactive token display.' }
    Import-Module (Join-Path $PSScriptRoot 'connector-vault.psm1') -Force
    $credential = Read-BenchmarkCredential
    if ([DateTimeOffset]::Parse($credential.expiresAt) -le [DateTimeOffset]::UtcNow) { throw 'Expired.' }
    [Console]::Out.Write(($credential | ConvertTo-Json -Depth 10 -Compress))
} catch {
    [Console]::Error.WriteLine('Owner connector setup is absent, expired or unavailable to this Windows account.')
    exit 1
}
