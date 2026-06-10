# Build deploy.zip for Elastic Beanstalk
Write-Host "Building deploy.zip..."

# Remove old zip if exists
if (Test-Path "deploy.zip") {
    Remove-Item "deploy.zip" -Force
    Write-Host "Removed old deploy.zip"
}

# Create zip from deploy directory contents
Compress-Archive -Path "deploy\*" -DestinationPath "deploy.zip" -Force
Write-Host "Created deploy.zip"

# Show size
$item = Get-Item "deploy.zip"
$sizeMB = [math]::Round($item.Length / 1MB, 2)
Write-Host "Size: $sizeMB MB"

# List contents summary
Write-Host "`nContents:"
$entries = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path "deploy.zip").Path).Entries
Write-Host "  Total entries: $($entries.Count)"
