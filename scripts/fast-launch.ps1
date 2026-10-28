# Optional acceleration only. The caller holds deployment.lock and has already selected a valid launch record.
function Save-FastLaunchHint($App,$InstallRoot,$RuntimeRoot,$StatePath){
  $installed=[bool](Test-Path -LiteralPath (Join-Path $App 'MANIFEST.json'))
  $selection=$null
  if($installed){
    $stateFile=Join-Path $InstallRoot 'current.json';$marker=Join-Path $InstallRoot 'install.json'
    if(!$StatePath -or [IO.Path]::GetFullPath($StatePath) -ne [IO.Path]::GetFullPath($stateFile)){return}
    $state=Read-Json $stateFile;$selection=$state.current.environment
    if([IO.Path]::GetFullPath((Join-Path $InstallRoot "apps/$($state.current.version)")) -ne [IO.Path]::GetFullPath($App)){return}
    if(!(Test-Path -LiteralPath $marker)){return}
    $build=Read-Json (Join-Path $App 'scripts/launcher-build.json')
    $executable=Join-Path $App 'scripts/MediaScope.Launcher.exe'
  }else{
    $stateFile='';$marker=''
    $builder=Join-Path $App 'scripts/build-launcher.ps1'
    if(!(Test-Path -LiteralPath $builder)){return}
    $build=& $builder
    $executable=Join-Path $App '.build/launcher/MediaScope.Launcher.exe'
  }
  $cached=Read-LaunchCache $App $InstallRoot $selection
  if(!$cached -or $build.schema -ne 1){return}
  $bootstrap=Join-Path $App 'scripts/fast-bootstrap.mjs'
  Assert-NoLinks $bootstrap -Shallow;Assert-NoLinks $executable -Shallow
  if((Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash -ne $build.executableHash -or (Get-FileHash -LiteralPath $bootstrap -Algorithm SHA256).Hash -ne $build.bootstrapHash){return}
  $cache=Get-LaunchCachePath $App $InstallRoot
  $hint=[IO.Path]::ChangeExtension($cache,'.fast')
  foreach($file in @($cache,$hint,$stateFile,$marker)){if($file -and (Test-Path -LiteralPath $file)){Assert-NoLinks $file -Shallow}}
  $fields=@($(if($installed){'installed'}else{'source'}),[IO.Path]::GetFullPath($App).TrimEnd('\'),[IO.Path]::GetFullPath($InstallRoot).TrimEnd('\'),[IO.Path]::GetFullPath($RuntimeRoot).TrimEnd('\'),$cached.paths.node,$cache,(Get-FileHash -LiteralPath $cache -Algorithm SHA256).Hash.ToLowerInvariant(),$stateFile,$(if($stateFile){(Get-FileHash -LiteralPath $stateFile -Algorithm SHA256).Hash.ToLowerInvariant()}else{''}),$marker,$(if($marker){(Get-FileHash -LiteralPath $marker -Algorithm SHA256).Hash.ToLowerInvariant()}else{''}),$build.fingerprint,$build.bootstrapHash)
  $stream=New-Object IO.MemoryStream;$writer=New-Object IO.BinaryWriter($stream)
  $pending=$hint+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
  try{
    foreach($field in $fields){$bytes=[Text.Encoding]::UTF8.GetBytes([string]$field);$writer.Write([int]$bytes.Length);$writer.Write($bytes)}
    $writer.Flush();$body=$stream.ToArray();$digest=[Security.Cryptography.SHA256]::Create()
    try{$checksum=$digest.ComputeHash($body)}finally{$digest.Dispose()}
    $file=[IO.File]::Open($pending,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$magic=[Text.Encoding]::ASCII.GetBytes('MSFAST03');$file.Write($magic,0,$magic.Length);$file.Write($checksum,0,$checksum.Length);$file.Write($body,0,$body.Length);$file.Flush()}finally{$file.Dispose()}
    for($attempt=0;;$attempt++){
      try{
        if([IO.File]::Exists($hint)){[IO.File]::Replace($pending,$hint,[NullString]::Value)}else{[IO.File]::Move($pending,$hint)}
        break
      }catch{
        $failure=$_.Exception;while($failure.InnerException){$failure=$failure.InnerException}
        if($failure -isnot [IO.IOException] -or ($failure.HResult -band 0xffff) -notin @(32,33,1175) -or $attempt -ge 7){throw}
        Start-Sleep -Milliseconds 125
      }
    }
  }finally{$writer.Dispose();$stream.Dispose();if([IO.File]::Exists($pending)){[IO.File]::Delete($pending)}}
}
