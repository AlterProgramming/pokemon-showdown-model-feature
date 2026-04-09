param(
	[Parameter(ValueFromRemainingArguments = $true)]
	[string[]]$LintFlags
)

$frontierRows = git status --short --untracked-files=all
if ($LASTEXITCODE -ne 0) {
	exit $LASTEXITCODE
}

$lintableSuffixes = @('.js', '.mjs', '.ts', '.tsx')
$settledPaths = New-Object 'System.Collections.Generic.HashSet[string]'

foreach ($frontierRow in $frontierRows) {
	if ([string]::IsNullOrWhiteSpace($frontierRow)) {
		continue
	}

	$rawPath = $frontierRow.Substring(3)
	$targetPath = if ($rawPath -like '* -> *') {
		($rawPath -split ' -> ')[-1]
	} else {
		$rawPath
	}

	$suffix = [System.IO.Path]::GetExtension($targetPath)
	if ($lintableSuffixes -notcontains $suffix) {
		continue
	}

	[void]$settledPaths.Add($targetPath)
}

$lintTargets = @($settledPaths)
if ($lintTargets.Count -eq 0) {
	Write-Output 'No send-scope lint targets.'
	exit 0
}

$nodePath = 'C:\Program Files\nodejs\node.exe'
$eslintPath = Join-Path $PSScriptRoot '..\node_modules\eslint\bin\eslint.js'

& $nodePath $eslintPath --cache @LintFlags @lintTargets
exit $LASTEXITCODE
