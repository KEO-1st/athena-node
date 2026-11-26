using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

/* Build-time only: draws the original ATHENA Node sigil at every Windows icon
   size. The committed assets/athena.ico is generated from this file. */
internal static class MakeAthenaIcon
{
    private static readonly int[] Sizes = { 16, 24, 32, 48, 64, 128, 256 };

    [STAThread]
    private static void Main(string[] args)
    {
        string output = args.Length > 0 ? args[0] : "assets/athena.ico";
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(output)));
        using (var stream = new MemoryStream())
        {
            var images = new byte[Sizes.Length][];
            for (int i = 0; i < Sizes.Length; i++)
            {
                using (var bitmap = Draw(Sizes[i])) images[i] = Dib(bitmap);
            }
            using (var writer = new BinaryWriter(stream))
            {
                writer.Write((ushort)0);
                writer.Write((ushort)1);
                writer.Write((ushort)Sizes.Length);
                int offset = 6 + 16 * Sizes.Length;
                for (int i = 0; i < Sizes.Length; i++)
                {
                    int size = Sizes[i];
                    writer.Write((byte)(size >= 256 ? 0 : size));
                    writer.Write((byte)(size >= 256 ? 0 : size));
                    writer.Write((byte)0);
                    writer.Write((byte)0);
                    writer.Write((ushort)1);
                    writer.Write((ushort)32);
                    writer.Write(images[i].Length);
                    writer.Write(offset);
                    offset += images[i].Length;
                }
                foreach (byte[] image in images) writer.Write(image);
            }
            File.WriteAllBytes(output, stream.ToArray());
        }
        Console.WriteLine("wrote " + output);
    }

    private static byte[] Dib(Bitmap bitmap)
    {
        int size = bitmap.Width;
        int maskStride = ((size + 31) / 32) * 4;
        int imageSize = size * size * 4;
        using (var stream = new MemoryStream())
        using (var writer = new BinaryWriter(stream))
        {
            writer.Write(40);
            writer.Write(size);
            writer.Write(size * 2);
            writer.Write((ushort)1);
            writer.Write((ushort)32);
            writer.Write(0);
            writer.Write(imageSize + maskStride * size);
            writer.Write(0);
            writer.Write(0);
            writer.Write(0);
            writer.Write(0);
            for (int y = size - 1; y >= 0; y--)
            {
                for (int x = 0; x < size; x++)
                {
                    Color c = bitmap.GetPixel(x, y);
                    writer.Write(c.B);
                    writer.Write(c.G);
                    writer.Write(c.R);
                    writer.Write(c.A);
                }
            }
            for (int y = 0; y < size; y++)
                for (int x = 0; x < maskStride; x++) writer.Write((byte)0);
            return stream.ToArray();
        }
    }

    private static Bitmap Draw(int size)
    {
        var bitmap = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using (var graphics = Graphics.FromImage(bitmap))
        {
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
            graphics.Clear(Color.Transparent);
            float s = size / 64f;
            float line = Math.Max(1.1f, 1.45f * s);
            using (var ring = new Pen(Color.FromArgb(150, 216, 169, 78), Math.Max(0.8f, line * 0.55f)))
            {
                ring.DashStyle = DashStyle.Custom;
                ring.DashPattern = new float[] { 1.3f, 4.2f };
                graphics.DrawEllipse(ring, 4.5f * s, 4.5f * s, 55f * s, 55f * s);
            }
            using (var wing = new Pen(Color.FromArgb(225, 216, 169, 78), line))
            {
                wing.StartCap = LineCap.Round;
                wing.EndCap = LineCap.Round;
                graphics.DrawBezier(wing, 29 * s, 16 * s, 20 * s, 11 * s, 12 * s, 11 * s, 5 * s, 15 * s);
                graphics.DrawBezier(wing, 35 * s, 16 * s, 44 * s, 11 * s, 52 * s, 11 * s, 59 * s, 15 * s);
            }

            using (var gradient = new LinearGradientBrush(new PointF(20 * s, 4 * s), new PointF(44 * s, 58 * s), Color.FromArgb(255, 255, 246, 223), Color.FromArgb(255, 141, 97, 28)))
            using (var spear = new GraphicsPath())
            using (var cross = new GraphicsPath())
            {
                PointF[] spearPoints =
                {
                    new PointF(32 * s, 4 * s), new PointF(39 * s, 25 * s), new PointF(35 * s, 52 * s),
                    new PointF(32 * s, 60 * s), new PointF(29 * s, 52 * s), new PointF(25 * s, 25 * s)
                };
                spear.AddPolygon(spearPoints);
                cross.AddPolygon(new PointF[]
                {
                    new PointF(17 * s, 29 * s), new PointF(47 * s, 29 * s),
                    new PointF(43 * s, 35 * s), new PointF(21 * s, 35 * s)
                });
                graphics.FillPath(gradient, spear);
                graphics.FillPath(gradient, cross);
                if (size >= 32)
                    using (var edge = new Pen(Color.FromArgb(235, 248, 230, 189), Math.Max(0.7f, s * 0.8f)))
                        graphics.DrawPath(edge, spear);
            }
            if (size >= 24)
            {
                using (var star = new SolidBrush(Color.FromArgb(255, 246, 219, 166)))
                    graphics.FillEllipse(star, 30.2f * s, 6.2f * s, 3.6f * s, 3.6f * s);
            }
        }
        return bitmap;
    }
}
