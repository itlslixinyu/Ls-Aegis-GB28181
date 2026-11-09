param([int]$SampleCount=3)
$ErrorActionPreference='Stop'
$root=(Resolve-Path '.').Path
$exe=Join-Path $root 'data/ai-tools/llama-b12189/bin/llama-mtmd-cli.exe'
$model=Join-Path $root 'data/ai-models/qwen3-vl-2b-q4/Qwen3VL-2B-Instruct-Q4_K_M.gguf'
$vision=Join-Path $root 'data/ai-models/qwen3-vl-2b-q4/mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf'
$outDir=Join-Path $root '.tmp/qwen-caption-results'
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
$promptPath=Join-Path $outDir 'prompt.txt'
[IO.File]::WriteAllText($promptPath,'请只根据图片可见内容，用简体中文输出两行：描述：一句简短、客观的画面描述（不超过60字，包含人数、主要物体、衣服颜色、位置或姿态）；标签：3至6个可用于搜索的关键词，用逗号分隔。看不清的信息请写不确定。不要推测身份、职业、情绪、意图，不要把单帧姿态描述成已确认发生的动作。',[Text.UTF8Encoding]::new($false))
$empty=Join-Path $outDir 'empty.txt';[IO.File]::WriteAllText($empty,'')
$client=[Net.Http.HttpClient]::new();$client.Timeout=[TimeSpan]::FromSeconds(3)
$baseline=($client.GetStringAsync('http://127.0.0.1:3000/api/health').GetAwaiter().GetResult()|ConvertFrom-Json).data.instanceId
$results=@()
for($sample=1;$sample -le $SampleCount;$sample++){
 $memory=Get-CimInstance Win32_OperatingSystem
 if($memory.FreePhysicalMemory*1024 -lt 2600MB){Write-Output 'Stopped: less than 2600MiB available before model launch';break}
 $out=Join-Path $outDir "sample-$sample.stdout.txt";$err=Join-Path $outDir "sample-$sample.stderr.txt"
 $inputImage=Join-Path $root ".tmp/qwen-caption-inputs/alarm-$sample.jpg"
 $argsList=@('-m',('"'+$model+'"'),'--mmproj',('"'+$vision+'"'),'--image',('"'+$inputImage+'"'),'-f',('"'+$promptPath+'"'),'-t','1','-tb','1','--cpu-mask','0x400','--cpu-strict','1','--prio','-1','--poll','0','-ngl','0','--no-mmproj-offload','-c','1024','-n','160','-b','256','-ub','64','--image-min-tokens','64','--image-max-tokens','256','--temp','0','--seed','2026','--no-warmup')
 $watch=[Diagnostics.Stopwatch]::StartNew()
 $child=Start-Process -FilePath $exe -ArgumentList $argsList -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err -RedirectStandardInput $empty -PassThru
 try{$child.PriorityClass='BelowNormal';$child.ProcessorAffinity=[IntPtr]1024}catch{}
 try {
 $peakWS=[long]0;$peakPrivate=[long]0;$minimumFree=[double]$memory.FreePhysicalMemory/1024;$health=@();$reason=$null;$cpuSeconds=0
 while(-not $child.HasExited){
  $child.Refresh();$peakWS=[Math]::Max($peakWS,$child.PeakWorkingSet64);$peakPrivate=[Math]::Max($peakPrivate,$child.PrivateMemorySize64);$cpuSeconds=$child.TotalProcessorTime.TotalSeconds
  $free=(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1024;$minimumFree=[Math]::Min($minimumFree,$free)
  $probe=[Diagnostics.Stopwatch]::StartNew()
  try{$h=($client.GetStringAsync('http://127.0.0.1:3000/api/health').GetAwaiter().GetResult()|ConvertFrom-Json).data;$health+=@{ms=$probe.Elapsed.TotalMilliseconds;ok=($h.status -eq 'ok' -and $h.instanceId -eq $baseline)};if($h.status -ne 'ok' -or $h.instanceId -ne $baseline){$reason='Platform health or instance changed'}}catch{$reason='Platform health check failed'}
  if($free -lt 768){$reason='Free physical memory below 768MiB'}
  if($peakWS -gt 2800MB){$reason='Model working set above 2800MiB'}
  if($watch.Elapsed.TotalSeconds -gt 300){$reason='Single-image timeout 300s'}
  if($reason){$child.Kill();$child.WaitForExit();break}
  Start-Sleep -Milliseconds 1000
 }
 $child.WaitForExit();$watch.Stop()
 $r=@{sample=$sample;elapsedSeconds=$watch.Elapsed.TotalSeconds;exitCode=$child.ExitCode;stopReason=$reason;peakWorkingSetMiB=$peakWS/1MB;peakPrivateMiB=$peakPrivate/1MB;cpuSeconds=$cpuSeconds;minimumFreeMiB=$minimumFree;healthChecks=$health.Count;healthFailures=@($health|Where-Object{-not $_.ok}).Count;healthMaxMs=($health.ms|Measure-Object -Maximum).Maximum;stdout=$out;stderr=$err}
 $results+=$r;$results|ConvertTo-Json -Depth 8|Set-Content -Encoding utf8 (Join-Path $outDir 'resource-results.json');Write-Output ($r|ConvertTo-Json -Compress)
 if($reason -or $child.ExitCode -ne 0){break}
 Start-Sleep -Seconds 3
 } finally { if(-not $child.HasExited){$child.Kill();$child.WaitForExit()} }
}
$client.Dispose()
