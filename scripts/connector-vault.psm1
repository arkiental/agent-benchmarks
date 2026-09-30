Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-BenchmarkVaultDirectory {
    if (-not $env:LOCALAPPDATA) { throw 'The owner Windows profile is unavailable.' }
    return Join-Path $env:LOCALAPPDATA 'AgentBenchmarks\Connector'
}
function Protect-BenchmarkDirectory {
    param([Parameter(Mandatory)][string]$Directory)
    if (-not [IO.Path]::IsPathRooted($Directory)) { throw 'Vault path must be absolute.' }
    if (-not (Test-Path -LiteralPath $Directory)) { New-Item -ItemType Directory -Path $Directory | Out-Null }
    $item = Get-Item -LiteralPath $Directory -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Vault folders cannot be links.' }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($sid)
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    $propagate = [Security.AccessControl.PropagationFlags]::None
    $allow = [Security.AccessControl.AccessControlType]::Allow
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inherit, $propagate, $allow)))
    $system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($system, 'FullControl', $inherit, $propagate, $allow)))
    Set-Acl -LiteralPath $Directory -AclObject $acl
}
function Save-BenchmarkCredential {
    param([Parameter(Mandatory)]$Credential, [string]$Directory = (Get-BenchmarkVaultDirectory), [switch]$Replace)
    Add-Type -AssemblyName System.Security
    Protect-BenchmarkDirectory -Directory $Directory
    $file = Join-Path $Directory 'credential.dpapi'
    if ((Test-Path -LiteralPath $file) -and -not $Replace) { throw 'A connector credential already exists. Use -Replace only when deliberately replacing it.' }
    $plain = [Text.Encoding]::UTF8.GetBytes(($Credential | ConvertTo-Json -Depth 10 -Compress))
    $entropy = [Text.Encoding]::UTF8.GetBytes('AgentBenchmarks.connector.v1')
    $temporary = Join-Path $Directory ([Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        $cipher = [Security.Cryptography.ProtectedData]::Protect($plain, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        [IO.File]::WriteAllBytes($temporary, $cipher)
        if (Test-Path -LiteralPath $file) { [IO.File]::Replace($temporary, $file, $null) } else { [IO.File]::Move($temporary, $file) }
    } finally {
        [Array]::Clear($plain, 0, $plain.Length)
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
    }
}
function Read-BenchmarkCredential {
    param([string]$Directory = (Get-BenchmarkVaultDirectory))
    Add-Type -AssemblyName System.Security
    $file = Join-Path $Directory 'credential.dpapi'
    $item = Get-Item -LiteralPath $file -Force
    if (-not $item -or $item.Length -gt 32768 -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Saved connector credential is invalid.' }
    $entropy = [Text.Encoding]::UTF8.GetBytes('AgentBenchmarks.connector.v1')
    $plain = $null
    try {
        $plain = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($file), $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        return ([Text.Encoding]::UTF8.GetString($plain) | ConvertFrom-Json)
    } finally { if ($null -ne $plain) { [Array]::Clear($plain, 0, $plain.Length) } }
}
function Remove-BenchmarkCredential {
    param([string]$Directory = (Get-BenchmarkVaultDirectory))
    $file = Join-Path $Directory 'credential.dpapi'
    if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file }
}
Export-ModuleMember -Function Get-BenchmarkVaultDirectory, Save-BenchmarkCredential, Read-BenchmarkCredential, Remove-BenchmarkCredential
