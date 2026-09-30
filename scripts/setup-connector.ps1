param(
    [string]$Site = 'https://bench.arkiental.com',
    [string[]]$UploadRoot,
    [switch]$AllowPublishing,
    [switch]$RegisterCodex,
    [switch]$Replace,
    [switch]$Forget
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'connector-vault.psm1') -Force
if ($Forget) { Remove-BenchmarkCredential; Write-Output 'Saved connector credential removed. Revoke the token in the owner Agent tokens page to disable all other copies.'; exit 0 }
$project = Split-Path $PSScriptRoot -Parent
$entry = Join-Path $project 'dist\scripts\connector.js'
if (-not (Test-Path -LiteralPath $entry)) { throw 'Run npm run build in the benchmark project first.' }
$node = (Get-Command node.exe -ErrorAction Stop).Source
$codexCommand = $null
if ($RegisterCodex) { $codexCommand = Get-Command codex -ErrorAction Stop }
$origin = [Uri]$Site
if ($origin.Scheme -notin @('http','https') -or $origin.UserInfo -or $origin.AbsolutePath -ne '/' -or $origin.Query -or $origin.Fragment) { throw 'Site must be a bare HTTPS origin.' }
if ($origin.Scheme -eq 'http' -and $origin.Host -notin @('localhost','127.0.0.1','::1')) { throw 'Remote sites require HTTPS.' }
$siteOrigin = $origin.GetLeftPart([UriPartial]::Authority)
if (-not $UploadRoot) {
    $uploads = Join-Path $project '.local\agent-uploads'
    if (-not (Test-Path -LiteralPath $uploads)) { New-Item -ItemType Directory -Path $uploads | Out-Null }
    $UploadRoot = @($uploads)
    $prepared = Join-Path $project '.local\bmd3-post\staging'
    if (Test-Path -LiteralPath $prepared) { $UploadRoot += $prepared }
}
$roots = @($UploadRoot | ForEach-Object {
    if (-not [IO.Path]::IsPathRooted($_)) { throw 'Specify absolute upload folders.' }
    $folder = Get-Item -LiteralPath $_ -Force
    if (-not $folder.PSIsContainer -or ($folder.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Choose existing local upload folders, without links.' }
    $folder.FullName
})
if ($roots.Count -lt 1 -or $roots.Count -gt 20) { throw 'Choose 1-20 upload folders.' }
$required = @('posts:read','posts:write','media:write')
if ($AllowPublishing) { $required += 'publish' }
Write-Output ('Saving an owner-issued token for ' + $siteOrigin + '. Required scopes: ' + ($required -join ', '))
Write-Output 'The token is encrypted for your Windows account, outside the repository. This does not create a token.'
$inputSecret = Read-Host 'Paste the owner-issued agent token (hidden)' -AsSecureString
$pointer = [IntPtr]::Zero
$token = $null
$client = $null
$handler = $null
try {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($inputSecret)
    $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    if ($token -notmatch '^abt_[a-f0-9]{64}$') { throw 'Use an agent token issued by the owner editor.' }
    Add-Type -AssemblyName System.Net.Http
    $handler = New-Object Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $false
    $client = New-Object Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(20)
    $client.MaxResponseContentBufferSize = 32768
    $request = New-Object Net.Http.HttpRequestMessage([Net.Http.HttpMethod]::Get, ($siteOrigin + '/api/v1/me'))
    $request.Headers.Authorization = New-Object Net.Http.Headers.AuthenticationHeaderValue('Bearer', $token)
    $response = $client.SendAsync($request).GetAwaiter().GetResult()
    if (-not $response.IsSuccessStatusCode) { throw ('Credential validation failed with HTTP ' + [int]$response.StatusCode + '. Nothing was saved.') }
    $info = ($response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json).token
    foreach ($scope in $required) { if ($scope -notin $info.scopes) { throw ('Credential needs ' + $scope + ' scope. Nothing was saved.') } }
    if ([DateTimeOffset]::Parse($info.expiresAt) -le [DateTimeOffset]::UtcNow) { throw 'The token has expired. Nothing was saved.' }
    $saved = [ordered]@{ version = 1; origin = $siteOrigin; secret = $token; expiresAt = $info.expiresAt; scopes = $required; allowPublishing = [bool]$AllowPublishing; uploadRoots = $roots }
    Save-BenchmarkCredential -Credential $saved -Replace:$Replace
    Write-Output ('Credential saved encrypted. Expiry: ' + $info.expiresAt)
    if ($RegisterCodex) {
        & $codexCommand.Source mcp add agent_benchmarks -- $node $entry
        if ($LASTEXITCODE -ne 0) { throw 'Credential is saved, but MCP registration failed. Add the STDIO command in desktop MCP settings.' }
        Write-Output 'MCP registered as agent_benchmarks. Restart/reconnect it in the desktop app or start a new Codex session, then check bench_status.'
    } else {
        Write-Output ('STDIO command: ' + $node)
        Write-Output ('STDIO argument: ' + $entry)
    }
} catch {
    Write-Error 'Connector setup failed. No credential is printed. Verify the origin, token scopes/expiry, and whether -Replace is needed; MCP registration may require reconnecting.'
    exit 1
} finally {
    $token = $null
    $saved = $null
    if ($null -ne $client) { $client.Dispose() }
    if ($null -ne $handler) { $handler.Dispose() }
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    if ($null -ne $inputSecret) { $inputSecret.Dispose() }
}
