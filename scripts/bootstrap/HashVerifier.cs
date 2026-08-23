using System;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

internal static class HashVerifier
{
    private static int Main(string[] args)
    {
        if (args.Length > 0 && string.Equals(args[0], "--join", StringComparison.OrdinalIgnoreCase)) return JoinAndVerify(args);
        if (args.Length != 3 || !ValidHash(args[1])) return 2;
        long expectedSize;
        if (!long.TryParse(args[2], NumberStyles.None, CultureInfo.InvariantCulture, out expectedSize) || expectedSize < 1) return 2;
        try
        {
            return Verify(args[0], args[1], expectedSize);
        }
        catch
        {
            return 5;
        }
    }

    private static int JoinAndVerify(string[] args)
    {
        if (args.Length < 7 || (args.Length - 4) % 3 != 0 || !ValidHash(args[2])) return 2;
        long expectedSize;
        if (!long.TryParse(args[3], NumberStyles.None, CultureInfo.InvariantCulture, out expectedSize) || expectedSize < 1) return 2;
        var output = args[1];
        try
        {
            using (var target = new FileStream(output, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                for (var index = 4; index < args.Length; index += 3)
                {
                    long partSize;
                    if (!ValidHash(args[index + 1]) || !long.TryParse(args[index + 2], NumberStyles.None, CultureInfo.InvariantCulture, out partSize) || partSize < 1) return 2;
                    var partResult = Verify(args[index], args[index + 1], partSize);
                    if (partResult != 0) return 10 + partResult;
                    using (var source = File.OpenRead(args[index])) source.CopyTo(target);
                }
            }
            return Verify(output, args[2], expectedSize);
        }
        catch
        {
            try { if (File.Exists(output)) File.Delete(output); } catch { }
            return 5;
        }
    }

    private static bool ValidHash(string value)
    {
        return !string.IsNullOrEmpty(value) && Regex.IsMatch(value, "^[0-9a-fA-F]{64}$");
    }

    private static int Verify(string file, string expectedHash, long expectedSize)
    {
        var info = new FileInfo(file);
        if (!info.Exists || info.Length != expectedSize) return 3;
        using (var stream = File.OpenRead(file))
        using (var sha = SHA256.Create())
        {
            var digest = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", string.Empty);
            return string.Equals(digest, expectedHash, StringComparison.OrdinalIgnoreCase) ? 0 : 4;
        }
    }
}
