Vendored Ballance asset converter tools (Windows x64).

BMap.dll, zlib.dll: built from MIT-licensed LibCmo21 a5aee0a, YYCCommonplace 422aa15,
stb 2e2bef and zlib 1.3.1. Static MSVC runtime, no VC Redist needed. BMap.dll needs
zlib.dll beside it.

dump-chunks.exe: this project's scripts/dump-original-chunks.cpp, statically linked
against the same LibCmo21, YYCCommonplace and zlib builds (MSVC, /MT). The importer
uses it to read the behavior graphs of your installed game. docs/original-import.md
gives the build command.

Original Ballance game files are NOT included. See THIRD_PARTY.md.
