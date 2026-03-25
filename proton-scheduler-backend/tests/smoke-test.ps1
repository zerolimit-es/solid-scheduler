#!/usr/bin/env pwsh
#
# smoke-test.ps1 — Quick health + endpoint verification for staging/production
#
# Usage:
#   .\smoke-test.ps1                           # defaults to http://localhost:3001
#   .\smoke-test.ps1 https://custom-url.example.com

param(
    [string]$Target = "staging"
)

$ErrorActionPreference = "Continue"

if ($Target -match "^http") {
    $BaseUrl = $Target
} else {
    $BaseUrl = "http://localhost:3001"
}

$Pass = 0
$Fail = 0

function Check {
    param([string]$Name, [int]$Expected, [string]$Url, [hashtable]$Options = @{})
    try {
        $splat = @{ Uri = $Url; Method = if ($Options.Method) { $Options.Method } else { "GET" }; TimeoutSec = 10; UseBasicParsing = $true }
        if ($Options.Body) { $splat.Body = $Options.Body; $splat.ContentType = "application/json" }
        $resp = Invoke-WebRequest @splat -ErrorAction Stop
        $code = $resp.StatusCode
    } catch {
        $code = [int]$_.Exception.Response.StatusCode
    }
    if ($code -eq $Expected) {
        Write-Host "  ✓ $Name (HTTP $code)" -ForegroundColor Green
        $script:Pass++
    } else {
        Write-Host "  ✗ $Name — expected $Expected, got $code" -ForegroundColor Red
        $script:Fail++
    }
}

function Check-JsonField {
    param([string]$Name, [string]$Url, [string]$Field, [string]$Expected)
    try {
        $resp = Invoke-RestMethod -Uri $Url -TimeoutSec 10 -ErrorAction Stop
        $actual = $resp.$Field
    } catch { $actual = $null }
    if ($actual -eq $Expected) {
        Write-Host "  ✓ $Name ($Field=$actual)" -ForegroundColor Green
        $script:Pass++
    } else {
        Write-Host "  ✗ $Name — expected $Field=`"$Expected`", got `"$actual`"" -ForegroundColor Red
        $script:Fail++
    }
}

function Check-Contains {
    param([string]$Name, [string]$Needle, [string]$Url, [hashtable]$Options = @{})
    try {
        $splat = @{ Uri = $Url; Method = if ($Options.Method) { $Options.Method } else { "GET" }; TimeoutSec = 10; UseBasicParsing = $true }
        if ($Options.Body) { $splat.Body = $Options.Body; $splat.ContentType = "application/json" }
        $resp = Invoke-WebRequest @splat -ErrorAction Stop
        $body = $resp.Content
    } catch {
        $body = $_.ErrorDetails.Message
        if (-not $body) { $body = $_.Exception.Message }
    }
    if ($body -match [regex]::Escape($Needle)) {
        Write-Host "  ✓ $Name (contains '$Needle')" -ForegroundColor Green
        $script:Pass++
    } else {
        Write-Host "  ✗ $Name — response does not contain '$Needle'" -ForegroundColor Red
        Write-Host "    Got: $($body | Select-Object -First 200)" -ForegroundColor DarkGray
        $script:Fail++
    }
}

function Check-Header {
    param([string]$Name, [string]$Header, [string]$Url, [hashtable]$Options = @{})
    try {
        $splat = @{ Uri = $Url; Method = if ($Options.Method) { $Options.Method } else { "GET" }; TimeoutSec = 10; UseBasicParsing = $true }
        if ($Options.Body) { $splat.Body = $Options.Body; $splat.ContentType = "application/json" }
        $resp = Invoke-WebRequest @splat -ErrorAction Stop
        $headers = $resp.Headers
    } catch {
        $headers = $_.Exception.Response.Headers
    }
    $found = $false
    if ($headers) {
        foreach ($key in $headers.Keys) {
            if ($key -match $Header) { $found = $true; break }
        }
    }
    if ($found) {
        Write-Host "  ✓ $Name" -ForegroundColor Green
        $script:Pass++
    } else {
        Write-Host "  ✗ $Name" -ForegroundColor Red
        $script:Fail++
    }
}

# ── Run Checks ────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════════"
Write-Host "  ProtonScheduler Smoke Tests"
Write-Host "  Target: $BaseUrl"
Write-Host "  Time:   $((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss')) UTC"
Write-Host "═══════════════════════════════════════════════════════════════"
Write-Host ""

$badBooking = '{"date":"bad","time":"bad","name":"","email":"notanemail"}'
$goodBooking = '{"date":"2026-03-01","time":"10:00","name":"Smoke","email":"smoke@test.com"}'

# 1. Health Check
Write-Host "Health Check"
Check "GET /health returns 200" 200 "$BaseUrl/health"
Check-JsonField "Health status is 'ok'" "$BaseUrl/health" "status" "ok"
Write-Host ""

# 2. API Info
Write-Host "API Info"
Check "GET /api returns 200" 200 "$BaseUrl/api"
Check-Contains "API name present" "ProtonScheduler" "$BaseUrl/api"
Write-Host ""

# 3. Auth Endpoints
Write-Host "Auth Endpoints"
Check "GET /api/auth/status returns 200" 200 "$BaseUrl/api/auth/status"
Check "GET /api/auth/providers returns 200" 200 "$BaseUrl/api/auth/providers"
Write-Host ""

# 4. Public Endpoints
Write-Host "Public Endpoints"
Check "GET /api/public/:slug returns 200" 200 "$BaseUrl/api/public/nonexistent-slug-test"
Write-Host ""

# 5. Input Validation
Write-Host "Input Validation"
Check "POST /api/public/:slug/book with bad data returns 400" 400 "$BaseUrl/api/public/test-smoke/book" @{ Method = "POST"; Body = $badBooking }
Check-Contains "Validation error has 'Validation failed'" "Validation failed" "$BaseUrl/api/public/test-smoke/book" @{ Method = "POST"; Body = $badBooking }
Check-Contains "Validation error has field details" "fields" "$BaseUrl/api/public/test-smoke/book" @{ Method = "POST"; Body = $badBooking }
Write-Host ""

# 6. Rate Limiting
Write-Host "Rate Limiting"
Check-Header "RateLimit-Limit header present" "RateLimit-Limit" "$BaseUrl/api/public/test-smoke/book" @{ Method = "POST"; Body = $goodBooking }
Check-Header "RateLimit-Remaining header present" "RateLimit-Remaining" "$BaseUrl/api/public/test-smoke/book" @{ Method = "POST"; Body = $goodBooking }
Write-Host ""

# 7. Error Handling
Write-Host "Error Handling"
Check "GET /nonexistent returns 404" 404 "$BaseUrl/api/nonexistent-route-test"
Write-Host ""

# ── Summary ───────────────────────────────────────────────────────────────

Write-Host "═══════════════════════════════════════════════════════════════"
Write-Host ""
if ($Fail -eq 0) {
    Write-Host "  All $Pass checks passed ✓" -ForegroundColor Green
} else {
    Write-Host "  $Fail check(s) failed, $Pass passed" -ForegroundColor Red
}
Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════════"

exit $Fail