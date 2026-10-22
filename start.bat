@echo off
rem NOTE: keep this file ASCII-only. Chinese inside a .bat gets mangled by the console codepage.
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "PYEXE="

rem --- 1) python on PATH. Actually run it: the Microsoft Store stub is on PATH
rem        but does nothing, so "where python" alone is not enough.
python -c "import sys;sys.exit(sys.version_info < (3,8))" >nul 2>nul
if not errorlevel 1 set "PYEXE=python"

rem --- 2) py launcher
if not defined PYEXE for /f "delims=" %%i in ('py -3 -c "import sys;sys.exit(1) if sys.version_info < (3,8) else print(sys.executable)" 2^>nul') do set "PYEXE=%%i"

rem --- 3) common install locations (CPython + Anaconda/Miniconda).
rem        %~d0 is this script's drive, so Anaconda installed next to the
rem        project (e.g. S:\Anaconda) is found without hardcoding a drive letter.
if not defined PYEXE (
  for %%d in (
    "%~d0\Anaconda\python.exe"
    "%~d0\Anaconda3\python.exe"
    "%~d0\anaconda3\python.exe"
    "%~d0\Miniconda3\python.exe"
    "%~d0\miniconda3\python.exe"
    "%USERPROFILE%\anaconda3\python.exe"
    "%USERPROFILE%\Anaconda3\python.exe"
    "%USERPROFILE%\miniconda3\python.exe"
    "C:\ProgramData\Anaconda3\python.exe"
    "C:\ProgramData\miniconda3\python.exe"
    "C:\Anaconda3\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python310\python.exe"
    "C:\Python313\python.exe"
    "C:\Python312\python.exe"
    "C:\Python311\python.exe"
    "C:\Python310\python.exe"
  ) do if not defined PYEXE if exist %%~d set "PYEXE=%%~d"
)

rem --- 4) fallback: python-path.txt (UTF-8; chcp 65001 above makes cmd read it correctly)
if not defined PYEXE if exist "python-path.txt" (
  for /f "usebackq delims=" %%i in ("python-path.txt") do (
    if not defined PYEXE (
      set "PYCAND=%%i"
      set "PYCAND=!PYCAND:"=!"
      if exist "!PYCAND!" set "PYEXE=!PYCAND!"
    )
  )
)

if not defined PYEXE (
  echo.
  echo   [x] Python not found.
  echo       Note-helper needs Python 3.8 or newer.
  echo.
  echo   Fix it either way:
  echo     1. Install Python from https://www.python.org/downloads/
  echo        and CHECK "Add python.exe to PATH" during setup.
  echo     2. Or put the full path to python.exe on one line in
  echo        python-path.txt next to this file.
  echo.
  if not "%NOTE_HELPER_NO_PAUSE%"=="1" pause
  exit /b 1
)

"!PYEXE!" -c "import sys;sys.exit(sys.version_info < (3,8))" >nul 2>nul
if errorlevel 1 (
  echo   [x] The selected Python is unavailable or older than 3.8.
  echo       Check python-path.txt or install a supported Python.
  if not "%NOTE_HELPER_NO_PAUSE%"=="1" pause
  exit /b 1
)

echo   Python: !PYEXE!
echo.
"!PYEXE!" server.py %*

rem Hold the window open only when something actually went wrong.
rem On a normal quit (Ctrl+C) it should just close, without asking for a keypress.
set "RC=!errorlevel!"
if not "!RC!"=="0" (
  echo.
  echo   [x] Note-helper exited with code !RC!.
  echo       Scroll up to read the error above.
  echo.
  if not "%NOTE_HELPER_NO_PAUSE%"=="1" pause
)
exit /b %RC%
