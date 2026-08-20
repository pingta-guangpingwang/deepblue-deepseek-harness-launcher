using System;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

internal static class HashVerifier
{
    private static int Main(string[] args)
    {
        if (args.Length != 3 || !Regex.IsMatch(args[1], "^[0-9a-fA-F]{64}$")) return 2;
        long expectedSize;
        if (!long.TryParse(args[2], NumberStyles.None, CultureInfo.InvariantCulture, out expectedSize) || expectedSize < 1) return 2;
        try
        {
            var info = new FileInfo(args[0]);
            if (!info.Exists || info.Length != expectedSize) return 3;
            using (var stream = File.OpenRead(args[0]))
            using (var sha = SHA256.Create())
            {
                var digest = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", string.Empty);
                return string.Equals(digest, args[1], StringComparison.OrdinalIgnoreCase) ? 0 : 4;
            }
        }
        catch
        {
            return 5;
        }
    }
}
