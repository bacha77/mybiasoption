$c = Get-Content 'c:\Users\PHILADELPHIE\OneDrive - PHILADELPHIE SDA (1)\Documents\BIAS\public\app.js'
$n = $c[0..1383] + $c[2253..($c.Length - 1)]
$n | Set-Content 'c:\Users\PHILADELPHIE\OneDrive - PHILADELPHIE SDA (1)\Documents\BIAS\public\app.js'
