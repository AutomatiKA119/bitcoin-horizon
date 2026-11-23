# Original synthwave instrumentals for the Horizon station.
# These are new compositions written for this project, not transcriptions of existing songs.
$ErrorActionPreference = "Stop"
$outDir = Join-Path $PSScriptRoot "..\midi"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function Get-VLQ([int]$value) {
    $bytes = New-Object System.Collections.Generic.List[byte]
    $bytes.Add([byte]($value -band 0x7F))
    $value = $value -shr 7
    while ($value -gt 0) {
        $bytes.Insert(0, [byte](($value -band 0x7F) -bor 0x80))
        $value = $value -shr 7
    }
    return $bytes.ToArray()
}

function Add-U32([System.Collections.Generic.List[byte]]$list, [int]$n) {
    $list.Add([byte](($n -shr 24) -band 255))
    $list.Add([byte](($n -shr 16) -band 255))
    $list.Add([byte](($n -shr 8) -band 255))
    $list.Add([byte]($n -band 255))
}

function Write-MidiFile([string]$path, [string]$title, [int]$bpm, [object[]]$notes) {
    $division = 480
    $events = New-Object System.Collections.Generic.List[object]
    foreach ($note in $notes) {
        $events.Add([pscustomobject]@{ Tick = [int]$note.Tick; Order = 1; Data = [byte[]](0x90, [byte]$note.Note, [byte]$note.Vel); Channel = [int]$note.Channel })
        $off = [int]$note.Tick + [int]$note.Dur
        $events.Add([pscustomobject]@{ Tick = $off; Order = 0; Data = [byte[]](0x80, [byte]$note.Note, 0); Channel = [int]$note.Channel })
    }
    $sorted = $events | Sort-Object Tick, Order, Channel

    $track = New-Object System.Collections.Generic.List[byte]
    $us = [int](60000000 / $bpm)
    $tempo = [byte[]](0xFF, 0x51, 0x03, [byte](($us -shr 16) -band 255), [byte](($us -shr 8) -band 255), [byte]($us -band 255))
    foreach ($b in (Get-VLQ 0)) { $track.Add($b) }
    foreach ($b in $tempo) { $track.Add($b) }

    $nameBytes = [System.Text.Encoding]::ASCII.GetBytes($title)
    foreach ($b in (Get-VLQ 0)) { $track.Add($b) }
    $track.Add(0xFF); $track.Add(0x03); $track.Add([byte]$nameBytes.Length)
    foreach ($b in $nameBytes) { $track.Add($b) }

    $last = 0
    foreach ($ev in $sorted) {
        $delta = [int]$ev.Tick - $last
        if ($delta -lt 0) { $delta = 0 }
        $last = [int]$ev.Tick
        $status = [byte](($ev.Data[0] -band 0xF0) -bor ($ev.Channel -band 0x0F))
        foreach ($b in (Get-VLQ $delta)) { $track.Add($b) }
        $track.Add($status)
        $track.Add([byte]$ev.Data[1])
        $track.Add([byte]$ev.Data[2])
    }
    foreach ($b in (Get-VLQ 0)) { $track.Add($b) }
    $track.Add(0xFF); $track.Add(0x2F); $track.Add(0x00)

    $file = New-Object System.Collections.Generic.List[byte]
    foreach ($c in [char[]]"MThd") { $file.Add([byte][char]$c) }
    Add-U32 $file 6
    $file.Add(0); $file.Add(0)
    $file.Add(0); $file.Add(1)
    $file.Add([byte](($division -shr 8) -band 255))
    $file.Add([byte]($division -band 255))
    foreach ($c in [char[]]"MTrk") { $file.Add([byte][char]$c) }
    Add-U32 $file $track.Count
    foreach ($b in $track) { $file.Add($b) }
    [System.IO.File]::WriteAllBytes($path, $file.ToArray())
}

function New-Song([string]$title, [int]$tonic, [int]$bpm, [int]$bars, [int[]]$prog, [int[]]$motif) {
    $tpq = 480
    $notes = New-Object System.Collections.Generic.List[object]
    function Add([int]$ch, [int]$note, [int]$vel, [int]$tick, [int]$dur) {
        if ($note -lt 0 -or $note -gt 127) { return }
        $notes.Add([pscustomobject]@{ Channel = $ch; Note = $note; Vel = $vel; Tick = $tick; Dur = $dur }) | Out-Null
    }
    for ($bar = 0; $bar -lt $bars; $bar++) {
        $degree = $prog[$bar % $prog.Length]
        $root = $tonic + $degree
        $barTick = $bar * $tpq * 4
        $tones = @($root, ($root + 3), ($root + 7))

        Add 0 ($root - 12) 96 $barTick ($tpq * 2 - 20)
        Add 0 ($root - 12) 84 ($barTick + $tpq * 2) ($tpq * 2 - 20)
        if (($bar % 4) -eq 3) {
            Add 0 ($root - 10) 80 ($barTick + $tpq * 3) ($tpq - 20)
        }

        Add 1 ($root + 12) 42 $barTick ($tpq * 4 - 10)
        Add 1 ($root + 15) 36 $barTick ($tpq * 4 - 10)
        Add 1 ($root + 19) 38 $barTick ($tpq * 4 - 10)
        Add 1 ($root + 24) 28 ($barTick + $tpq) ($tpq * 3 - 10)

        for ($step = 0; $step -lt 8; $step++) {
            $tone = $tones[$step % 3] + 12
            if (($step % 4) -eq 3) { $tone += 12 }
            $vel = 70 + (($step % 2) * 18)
            Add 2 $tone $vel ($barTick + [int]($step * $tpq / 2)) ([int]($tpq / 2) - 15)
        }

        $leadStart = $motif[$bar % $motif.Length]
        Add 3 ($root + 24 + $leadStart) (78 + ($bar % 3) * 6) ($barTick + $tpq) ($tpq * 2 - 30)
        if (($bar % 2) -eq 0) {
            Add 3 ($root + 24 + $motif[($bar + 1) % $motif.Length]) 88 ($barTick + $tpq * 3) ($tpq - 20)
        }

        Add 9 36 110 $barTick 200
        Add 9 36 90 ($barTick + $tpq * 2) 180
        if (($bar % 8) -eq 7) { Add 9 36 100 ($barTick + [int]($tpq * 2.5)) 120 }
        Add 9 38 100 ($barTick + $tpq) 180
        Add 9 38 96 ($barTick + $tpq * 3) 180
        for ($hat = 0; $hat -lt 8; $hat++) {
            $velHat = ($(if (($hat % 2) -eq 0) { 70 } else { 46 }))
            Add 9 42 $velHat ($barTick + [int]($hat * $tpq / 2)) 60
        }
        if (($bar % 4) -eq 0) { Add 9 46 64 $barTick 400 }
    }
    return $notes.ToArray()
}

$songs = @(
    @{ File = "glass-runway.mid"; Title = "GLASS RUNWAY"; Tonic = 57; Bpm = 104; Bars = 32; Prog = @(0, 8, 3, 10); Motif = @(0, 3, 7, 10, 7, 3, 12, 7) },
    @{ File = "sodium-lights.mid"; Title = "SODIUM LIGHTS"; Tonic = 50; Bpm = 96; Bars = 32; Prog = @(0, 5, 10, 8); Motif = @(0, 7, 3, 10, 12, 7, 3, 0) },
    @{ File = "afterburn.mid"; Title = "AFTERBURN"; Tonic = 52; Bpm = 120; Bars = 36; Prog = @(0, 10, 8, 7); Motif = @(7, 3, 0, 12, 10, 7, 3, 15) },
    @{ File = "cable-city.mid"; Title = "CABLE CITY"; Tonic = 54; Bpm = 100; Bars = 32; Prog = @(0, 3, 8, 10); Motif = @(0, 12, 7, 3, 10, 15, 7, 0) },
    @{ File = "red-shift.mid"; Title = "RED SHIFT"; Tonic = 48; Bpm = 112; Bars = 32; Prog = @(0, 7, 8, 3); Motif = @(3, 7, 12, 7, 0, 10, 7, 3) },
    @{ File = "night-market.mid"; Title = "NIGHT MARKET"; Tonic = 55; Bpm = 108; Bars = 36; Prog = @(0, 8, 5, 10); Motif = @(0, 3, 10, 7, 12, 3, 7, 0) }
)

foreach ($song in $songs) {
    $notes = New-Song $song.Title $song.Tonic $song.Bpm $song.Bars $song.Prog $song.Motif
    $path = Join-Path $outDir $song.File
    Write-MidiFile $path $song.Title $song.Bpm $notes
    $len = (Get-Item $path).Length
    Write-Output "$($song.File) $len bytes"
}
