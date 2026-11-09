$ErrorActionPreference='Stop'
# Local AI media tools only; does not modify the existing live/recording FFmpeg configuration.
$projectRoot=Split-Path -Parent $PSScriptRoot
$target=Join-Path $projectRoot 'data/ai-tools'
New-Item -ItemType Directory -Path $target -Force | Out-Null
$archive=Join-Path $target 'ffmpeg-9.0.2.zip'
$expected='60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba'
if(-not(Test-Path -LiteralPath $archive)) { Invoke-WebRequest -Uri 'https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip' -OutFile $archive -TimeoutSec 180 }
if((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected){throw 'FFmpeg archive SHA256 mismatch'}
Expand-Archive -LiteralPath $archive -DestinationPath $target -Force
$executable=Join-Path $target 'ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe'
if(-not(Test-Path -LiteralPath $executable)){throw 'FFmpeg executable missing'}
Write-Output ('AI_ARCHIVE_FFMPEG_EXECUTABLE='+$executable)
