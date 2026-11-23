$ErrorActionPreference = "Stop"
$root = "C:\Users\user\Projects\bitcoin-horizon"
$prefix = "http://localhost:5173/"
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
$listener.Start()
Write-Output "SERVING $prefix"
$types = @{
  ".html" = "text/html; charset=utf-8"
  ".js" = "text/javascript; charset=utf-8"
  ".css" = "text/css; charset=utf-8"
  ".jpg" = "image/jpeg"
  ".mid" = "audio/midi"
}
$sessions = @{}

function Get-SaverCount {
    $now = [DateTime]::UtcNow
    foreach ($key in @($sessions.Keys)) {
        if (($now - $sessions[$key]).TotalSeconds -gt 40) { $sessions.Remove($key) }
    }
    return $sessions.Count
}

function Send-Json($response, [string]$json) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $response.ContentType = "application/json; charset=utf-8"
    $response.ContentLength64 = $bytes.Length
    $response.OutputStream.Write($bytes, 0, $bytes.Length)
}

while ($listener.IsListening) {
  try {
    $context = $listener.GetContext()
    $path = [Uri]::UnescapeDataString($context.Request.Url.AbsolutePath)
    if ($path -eq "/api/screensaver") {
      if ($context.Request.HttpMethod -eq "POST") {
        $reader = New-Object System.IO.StreamReader($context.Request.InputStream, $context.Request.ContentEncoding)
        $payload = $reader.ReadToEnd() | ConvertFrom-Json
        $id = [string]$payload.id
        if ($id) {
          if ($payload.active) { $sessions[$id] = [DateTime]::UtcNow }
          else { $sessions.Remove($id) }
        }
      }
      Send-Json $context.Response ("{""count"":" + (Get-SaverCount) + "}")
      $context.Response.Close()
      continue
    }
    if ($path -eq "/") { $path = "/index.html" }
    $file = Join-Path $root ($path.TrimStart("/") -replace "/", "\")
    if ((Test-Path $file) -and -not (Get-Item $file).PSIsContainer) {
      $bytes = [System.IO.File]::ReadAllBytes($file)
      $ext = [System.IO.Path]::GetExtension($file).ToLowerInvariant()
      $context.Response.ContentType = $types[$ext]
      if (-not $context.Response.ContentType) { $context.Response.ContentType = "application/octet-stream" }
      $context.Response.ContentLength64 = $bytes.Length
      $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $context.Response.StatusCode = 404
    }
    $context.Response.Close()
  } catch {
    Write-Output $_.Exception.Message
    try { $context.Response.StatusCode = 500; $context.Response.Close() } catch {}
  }
}
