# 0.2.0 Windows BAT security advisory

## Summary

The 0.2.0 single-file Windows BAT distribution is retired. Microsoft Defender can classify its runtime behavior as `Trojan:JS/ChatGPTStealer.GVA!MTB` through AMSI because the BAT starts hidden PowerShell, bypasses the local execution policy, writes an embedded executable and compressed payload to disk, and launches the extracted application.

The detection record observed during release testing identified the PowerShell AMSI session rather than a DeepSeek Harness source file. This does not prove that the package contained the named malware, but the self-extracting design was too similar to a script-based loader to remain suitable for public distribution.

## User action

Do not add a Defender exclusion and do not restore the retired BAT from quarantine. Delete any previously downloaded 0.2.0 BAT and download a current standard installer EXE instead.

## Remediation

Version 0.2.1 removes the self-extracting runtime entirely. The ZIP contains no hidden PowerShell, execution-policy bypass, embedded executable writer, or runtime decompressor. Its optional BAT contains only local EXE discovery and `start` commands.

Version 0.2.2 replaces the intermediate ZIP with a standard NSIS one-click installer. It shows installation progress, creates Windows shortcuts, and starts the installed application without a BAT or PowerShell bootstrap.

Both final ZIPs, both extracted directories, both public-download copies, and the legacy redirect BATs returned `found no threats` with Microsoft Defender platform `4.18.26070.9-0` and security intelligence `1.457.173.0` during the 2026-08-15 release verification.

The final 0.2.2 online and offline installer EXEs and the installed application directory also returned `found no threats` during release verification. The offline installer was installed and started a real Harness Web service that returned HTTP 200.

## 0.2.1 checksums

```text
online  2df6ad4c85a5a1a34e138c6b750d4eb3f74c62848d66dd5a910590bda8616b43
offline 0870b2c9d41e75e7f714861b1f46998e5894814f76aa16d72d9592593d283eda
```

## 0.2.2 checksums

```text
online  0d5c81587270490340f152131718dd2ceb59d50e145694614c99f7a030f5dcae
offline f3e37de638259c90e0a169a1b2533810be661445798f12da10fcab0a5e8da178
```
