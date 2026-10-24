# NetSpot Clone - Windows WLAN API bridge
# Compiles a tiny P/Invoke helper once and answers one JSON line per "scan"
# request on stdin. All output is ASCII-escaped JSON.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$source = @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

public static class WlanScan
{
    [DllImport("wlanapi.dll")]
    private static extern uint WlanOpenHandle(uint dwClientVersion, IntPtr pReserved, out uint pdwNegotiatedVersion, out IntPtr phClientHandle);

    [DllImport("wlanapi.dll")]
    private static extern uint WlanCloseHandle(IntPtr hClientHandle, IntPtr pReserved);

    [DllImport("wlanapi.dll")]
    private static extern uint WlanEnumInterfaces(IntPtr hClientHandle, IntPtr pReserved, out IntPtr ppInterfaceList);

    [DllImport("wlanapi.dll")]
    private static extern uint WlanGetNetworkBssList(IntPtr hClientHandle, ref Guid pInterfaceGuid, IntPtr pDot11Ssid, int dot11BssType, bool bSecurityEnabled, IntPtr pReserved, out IntPtr ppWlanBssList);

    [DllImport("wlanapi.dll")]
    private static extern void WlanFreeMemory(IntPtr pMemory);

    private const int InterfaceInfoSize = 532;
    private const int BssEntrySize = 352;

    public static string Scan()
    {
        IntPtr handle = IntPtr.Zero;
        uint negotiated = 0;
        uint rc = WlanOpenHandle(2, IntPtr.Zero, out negotiated, out handle);
        if (rc != 0) throw new Exception("WlanOpenHandle: " + rc);

        List<string> adapters = new List<string>();
        List<string> aps = new List<string>();

        try
        {
            IntPtr ifList;
            rc = WlanEnumInterfaces(handle, IntPtr.Zero, out ifList);
            if (rc != 0) throw new Exception("WlanEnumInterfaces: " + rc);

            try
            {
                int count = Marshal.ReadInt32(ifList);
                for (int i = 0; i < count; i++)
                {
                    long baseAddr = ifList.ToInt64() + 8 + (long)i * InterfaceInfoSize;
                    Guid guid = (Guid)Marshal.PtrToStructure(new IntPtr(baseAddr), typeof(Guid));
                    string desc = Marshal.PtrToStringUni(new IntPtr(baseAddr + 16));
                    if (desc == null) desc = "";
                    int state = Marshal.ReadInt32(new IntPtr(baseAddr + 528));
                    adapters.Add("{\"description\":\"" + Esc(desc) + "\",\"state\":" + state.ToString(CultureInfo.InvariantCulture) + "}");

                    IntPtr bssList;
                    uint brc = WlanGetNetworkBssList(handle, ref guid, IntPtr.Zero, 3, false, IntPtr.Zero, out bssList);
                    if (brc != 0) continue;

                    try
                    {
                        int n = Marshal.ReadInt32(new IntPtr(bssList.ToInt64() + 4));
                        for (int k = 0; k < n; k++)
                        {
                            long entry = bssList.ToInt64() + 8 + (long)k * BssEntrySize;
                            aps.Add(BuildEntry(entry, desc));
                        }
                    }
                    finally
                    {
                        WlanFreeMemory(bssList);
                    }
                }
            }
            finally
            {
                WlanFreeMemory(ifList);
            }
        }
        finally
        {
            WlanCloseHandle(handle, IntPtr.Zero);
        }

        return "{\"adapters\":[" + string.Join(",", adapters.ToArray()) + "],\"aps\":[" + string.Join(",", aps.ToArray()) + "]}";
    }

    private static string BuildEntry(long e, string adapter)
    {
        int ssidLen = Marshal.ReadInt32(new IntPtr(e));
        if (ssidLen < 0 || ssidLen > 32) ssidLen = 0;

        string ssid = "";
        if (ssidLen > 0)
        {
            byte[] ssidBytes = new byte[ssidLen];
            Marshal.Copy(new IntPtr(e + 4), ssidBytes, 0, ssidLen);
            ssid = Encoding.UTF8.GetString(ssidBytes).TrimEnd('\0');
        }

        byte[] mac = new byte[6];
        Marshal.Copy(new IntPtr(e + 40), mac, 0, 6);
        StringBuilder macText = new StringBuilder(17);
        for (int i = 0; i < 6; i++)
        {
            if (i > 0) macText.Append(':');
            macText.Append(mac[i].ToString("x2", CultureInfo.InvariantCulture));
        }

        int phy = Marshal.ReadInt32(new IntPtr(e + 52));
        int capability = Marshal.ReadInt32(new IntPtr(e + 76)) & 0xFFFF;
        int rssi = Marshal.ReadInt32(new IntPtr(e + 80));
        uint freq = (uint)Marshal.ReadInt32(new IntPtr(e + 84));

        int rateLen = Marshal.ReadInt32(new IntPtr(e + 88));
        if (rateLen < 0) rateLen = 0;
        if (rateLen > 126) rateLen = 126;
        int maxRate = 0;
        for (int r = 0; r < rateLen; r++)
        {
            int value = Marshal.ReadInt16(new IntPtr(e + 92 + r * 2)) & 0xFFFF;
            if (value > maxRate) maxRate = value;
        }

        int ieOffset = Marshal.ReadInt32(new IntPtr(e + 344));
        int ieSize = Marshal.ReadInt32(new IntPtr(e + 348));
        int primary = 0;
        int width = 0;
        string security = "";

        if (ieOffset > 0 && ieSize > 0 && ieOffset + ieSize <= 16384)
        {
            long ie = e + ieOffset;
            int pos = 0;
            while (pos + 2 <= ieSize)
            {
                int id = Marshal.ReadByte(new IntPtr(ie + pos));
                int len = Marshal.ReadByte(new IntPtr(ie + pos + 1));
                if (pos + 2 + len > ieSize) break;
                long data = ie + pos + 2;

                if (id == 3 && len >= 1)
                {
                    primary = Marshal.ReadByte(new IntPtr(data));
                }
                else if (id == 48 && len >= 2)
                {
                    string parsed = ParseRsn(data, len);
                    if (parsed.Length > 0) security = parsed;
                }
                else if (id == 221 && len >= 4)
                {
                    int o0 = Marshal.ReadByte(new IntPtr(data));
                    int o1 = Marshal.ReadByte(new IntPtr(data + 1));
                    int o2 = Marshal.ReadByte(new IntPtr(data + 2));
                    int o3 = Marshal.ReadByte(new IntPtr(data + 3));
                    if (o0 == 0x00 && o1 == 0x50 && o2 == 0xF2 && o3 == 0x01 && security.Length == 0)
                        security = "WPA";
                }
                else if (id == 61 && len >= 2)
                {
                    int b = Marshal.ReadByte(new IntPtr(data + 1));
                    if ((b & 0x04) != 0 || (b & 0x03) != 0) width = Math.Max(width, 40);
                }
                else if (id == 192 && len >= 1)
                {
                    int vw = Marshal.ReadByte(new IntPtr(data));
                    if (vw == 1) width = Math.Max(width, 80);
                    else if (vw == 2) width = Math.Max(width, 160);
                    else if (vw == 3) width = 8080;
                }

                pos += 2 + len;
            }
        }

        int centerChannel = 0;
        if (freq >= 2400 && freq < 2500)
            centerChannel = freq == 2484 ? 14 : (int)Math.Round((freq - 2407.0) / 5.0);
        else if (freq >= 4900 && freq < 5925)
            centerChannel = (int)Math.Round((freq - 5000.0) / 5.0);
        else if (freq >= 5925)
            centerChannel = (int)Math.Round((freq - 5950.0) / 5.0);

        if (width < 80)
        {
            if (freq >= 4900 && freq < 5925)
            {
                if (centerChannel == 50 || centerChannel == 114 || centerChannel == 163) width = 160;
                else if (centerChannel == 42 || centerChannel == 58 || centerChannel == 106 || centerChannel == 122 || centerChannel == 138 || centerChannel == 155 || centerChannel == 171) width = 80;
                else if (centerChannel == 38 || centerChannel == 46 || centerChannel == 54 || centerChannel == 62 || centerChannel == 102 || centerChannel == 110 || centerChannel == 118 || centerChannel == 126 || centerChannel == 134 || centerChannel == 142 || centerChannel == 151 || centerChannel == 159 || centerChannel == 167 || centerChannel == 175) { if (width < 40) width = 40; }
            }
            else if (freq >= 5925)
            {
                if (centerChannel == 31 || centerChannel == 63 || centerChannel == 95 || centerChannel == 127 || centerChannel == 159 || centerChannel == 191) width = 320;
                else if (centerChannel == 15 || centerChannel == 47 || centerChannel == 79 || centerChannel == 111 || centerChannel == 143 || centerChannel == 175 || centerChannel == 207) width = 160;
                else if (centerChannel == 7 || centerChannel == 23 || centerChannel == 39 || centerChannel == 55 || centerChannel == 71 || centerChannel == 87 || centerChannel == 103 || centerChannel == 119 || centerChannel == 135 || centerChannel == 151 || centerChannel == 167 || centerChannel == 183 || centerChannel == 199 || centerChannel == 215) width = 80;
            }
        }
        if (width == 0) width = 20;

        if (security.Length == 0)
            security = (capability & 0x10) != 0 ? "WEP" : "Aberta";

        int channel = primary > 0 ? primary : centerChannel;

        StringBuilder json = new StringBuilder(256);
        json.Append('{');
        json.Append("\"ssid\":\"").Append(Esc(ssid)).Append("\",");
        json.Append("\"bssid\":\"").Append(macText.ToString()).Append("\",");
        json.Append("\"rssi\":").Append(rssi.ToString(CultureInfo.InvariantCulture)).Append(',');
        json.Append("\"channel\":").Append(channel.ToString(CultureInfo.InvariantCulture)).Append(',');
        json.Append("\"centerChannel\":").Append(centerChannel.ToString(CultureInfo.InvariantCulture)).Append(',');
        json.Append("\"freq\":").Append(freq.ToString(CultureInfo.InvariantCulture)).Append(',');
        json.Append("\"width\":").Append(width.ToString(CultureInfo.InvariantCulture)).Append(',');
        json.Append("\"phyCode\":").Append(phy.ToString(CultureInfo.InvariantCulture)).Append(',');
        json.Append("\"security\":\"").Append(Esc(security)).Append("\",");
        json.Append("\"privacy\":").Append((capability & 0x10) != 0 ? "true" : "false").Append(',');
        json.Append("\"rate\":").Append((maxRate / 2).ToString(CultureInfo.InvariantCulture)).Append(',');
        json.Append("\"adapter\":\"").Append(Esc(adapter)).Append('"');
        json.Append('}');
        return json.ToString();
    }

    private static string ParseRsn(long data, int len)
    {
        if (len < 8) return "WPA2";
        int pos = 2; // version
        pos += 4;    // group cipher
        if (pos + 2 > len) return "WPA2";
        int pairCount = Marshal.ReadByte(new IntPtr(data + pos)) | (Marshal.ReadByte(new IntPtr(data + pos + 1)) << 8);
        pos += 2 + pairCount * 4;
        if (pos + 2 > len) return "WPA2";
        int akmCount = Marshal.ReadByte(new IntPtr(data + pos)) | (Marshal.ReadByte(new IntPtr(data + pos + 1)) << 8);
        pos += 2;

        bool sae = false;
        bool enterprise = false;
        for (int i = 0; i < akmCount && pos + 4 <= len; i++)
        {
            int type = Marshal.ReadByte(new IntPtr(data + pos + 3));
            if (type == 8 || type == 9 || type == 18) sae = true;
            if (type == 1 || type == 3) enterprise = true;
            pos += 4;
        }

        if (sae) return enterprise ? "WPA3-Enterprise" : "WPA3";
        if (enterprise) return "WPA2-Enterprise";
        return "WPA2";
    }

    private static string Esc(string value)
    {
        if (value == null) return "";
        StringBuilder b = new StringBuilder(value.Length + 8);
        foreach (char c in value)
        {
            if (c == '"') b.Append("\\\"");
            else if (c == '\\') b.Append("\\\\");
            else if (c == '\n') b.Append("\\n");
            else if (c == '\r') b.Append("\\r");
            else if (c == '\t') b.Append("\\t");
            else if (c < 32 || c > 126) b.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
            else b.Append(c);
        }
        return b.ToString();
    }
}
'@

try {
    Add-Type -TypeDefinition $source -Language CSharp | Out-Null
    [Console]::Out.WriteLine('READY')
    [Console]::Out.Flush()
}
catch {
    $message = $_.Exception.Message -replace "`r|`n", ' '
    [Console]::Out.WriteLine('FATAL ' + $message)
    [Console]::Out.Flush()
    exit 1
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line -or $line.Trim() -eq 'quit') { break }
    try {
        $json = [WlanScan]::Scan()
        [Console]::Out.WriteLine('DATA ' + $json)
    }
    catch {
        $message = $_.Exception.Message -replace "`r|`n", ' '
        [Console]::Out.WriteLine('ERR ' + $message)
    }
    [Console]::Out.Flush()
}
