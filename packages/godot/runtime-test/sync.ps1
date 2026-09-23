# Copies the AIGE C# runtime (packages/godot/runtime) into this test project as addons/aige.
# Run from anywhere: powershell -ExecutionPolicy Bypass -File packages/godot/runtime-test/sync.ps1
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path $here '..\runtime'
$dst = Join-Path $here 'addons\aige'
if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item -Recurse -Force (Join-Path $src '*') $dst
Get-ChildItem -Recurse -File $dst -Filter *.md | Remove-Item -Force
Write-Host "Synced runtime -> $dst ($((Get-ChildItem -Recurse -File $dst -Filter *.cs).Count) .cs files)"
