import type { Metadata } from "next";
import type { ReactNode } from "react";
import { PRIVACY_UPDATED, PRIVACY_VERSION } from "@/lib/privacy";

/*
 * Privacy notice (spec 8.3, UU PDP 27/2022), linked from the consent message
 * in onboarding. Plain Bahasa for owners. Have it reviewed by a lawyer before
 * the pilot; keep it in step with what the code actually does.
 */

export const metadata: Metadata = { title: "Kebijakan Privasi · BukuWA" };

// Read at request time so the contact can be set per deployment.
export const dynamic = "force-dynamic";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="space-y-2 text-ink-2 [&_b]:text-ink [&_li]:ml-5 [&_li]:list-disc">{children}</div>
    </section>
  );
}

export default function PrivacyPage() {
  const contact = process.env.PRIVACY_CONTACT_EMAIL;
  const graceDays = Number(process.env.ERASURE_GRACE_DAYS ?? 7);
  return (
    <main className="mx-auto max-w-2xl space-y-6 px-4 py-10 leading-relaxed">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Kebijakan Privasi BukuWA</h1>
        <p className="text-sm text-ink-3">
          Versi {PRIVACY_VERSION} · berlaku sejak {PRIVACY_UPDATED}
        </p>
      </header>

      <p className="text-ink-2">
        BukuWA adalah asisten pembukuan di WhatsApp untuk usaha kecil. Halaman ini menjelaskan data apa yang kami simpan, untuk apa, siapa saja yang
        ikut memprosesnya, dan bagaimana kamu bisa minta salinan atau menghapusnya. Kami mengikuti Undang-Undang Pelindungan Data Pribadi (UU No. 27
        Tahun 2022).
      </p>

      <Section title="1. Siapa yang bertanggung jawab">
        <p>BukuWA adalah pengendali data atas data yang kamu kirim ke nomor WhatsApp BukuWA dan dashboard web BukuWA.</p>
        <p>
          Kontak pelindungan data:{" "}
          {contact ? <a className="font-medium text-ink underline underline-offset-2" href={`mailto:${contact}`}>{contact}</a> : <b>belum diatur</b>}
        </p>
      </Section>

      <Section title="2. Data yang kami simpan">
        <ul>
          <li>Nomor WhatsApp kamu (disimpan terenkripsi).</li>
          <li>Nama dan jenis usaha, saldo kas awal, dan pengaturan seperti jam ringkasan.</li>
          <li>Transaksi yang kamu catat, beserta pesan chat, foto nota, bukti transfer, PDF, dan voice note yang kamu kirim sebagai buktinya.</li>
          <li>Nama dan nomor pelanggan atau supplier yang kamu sebut (misalnya untuk catatan piutang).</li>
          <li>Riwayat aktivitas: kapan kamu setuju kebijakan ini, login ke dashboard, ekspor laporan, dan perubahan transaksi.</li>
        </ul>
      </Section>

      <Section title="3. Untuk apa data dipakai">
        <ul>
          <li>Mencatat pembukuan, menjawab pertanyaan soal usahamu, mengirim ringkasan, dan menyiapkan perkiraan pajak serta laporan bulanan.</li>
          <li>Menjaga keamanan akun dan membantu kalau ada kendala.</li>
          <li>
            Memperbaiki akurasi: tim kami bisa melihat contoh pesan yang gagal dibaca, dengan NIK, NPWP dan nomor HP disamarkan. Contoh yang dipakai untuk
            pengujian sistem dibersihkan dari data pribadi.
          </li>
        </ul>
        <p>Data kamu <b>tidak dijual</b> dan tidak dipakai untuk iklan.</p>
      </Section>

      <Section title="4. Dasar pemrosesan">
        <p>Persetujuan yang kamu berikan di WhatsApp saat mulai memakai BukuWA. Kamu bisa menariknya kapan saja (lihat bagian 8).</p>
      </Section>

      <Section title="5. Di mana data disimpan dan siapa yang ikut memproses">
        <ul>
          <li>Database dan file bukti disimpan di server di Indonesia (Jakarta).</li>
          <li>Pesan WhatsApp dikirim dan diterima lewat WhatsApp Business Platform milik Meta.</li>
          <li>
            Supaya chat, foto dan voice note bisa dibaca, isinya dikirim ke penyedia AI <b>Anthropic</b> (Amerika Serikat). NIK dan NPWP yang ada di teks
            disamarkan dulu sebelum dikirim; foto dikirim apa adanya. Anthropic tidak memakai data ini untuk melatih model AI-nya.
          </li>
          <li>Kalau nanti ada penyedia lain (misalnya untuk mengubah voice note jadi teks), daftar ini akan diperbarui sebelum dipakai.</li>
        </ul>
      </Section>

      <Section title="6. Keamanan">
        <ul>
          <li>Nomor HP dan NPWP disimpan terenkripsi. Data tiap usaha dipisahkan di database sehingga satu usaha tidak bisa melihat data usaha lain.</li>
          <li>Link unduhan laporan berlaku 15 menit. Sesi dashboard berakhir setelah 7 hari.</li>
          <li>Akses tim BukuWA dibatasi dan setiap kali tim membuka riwayat pesan sebuah usaha, itu tercatat.</li>
        </ul>
      </Section>

      <Section title="7. Berapa lama data disimpan">
        <p>
          Selama kamu memakai BukuWA. Kalau kamu minta hapus data, semuanya dihapus permanen {graceDays} hari setelah kamu konfirmasi (selama {graceDays} hari
          itu kamu masih bisa membatalkan).
        </p>
      </Section>

      <Section title="8. Hak kamu">
        <ul>
          <li><b>Minta salinan data:</b> ketik <b>ekspor data</b> ke BukuWA. Kamu dapat file Excel berisi semua data usahamu.</li>
          <li><b>Memperbaiki data:</b> koreksi transaksi lewat chat (misalnya &ldquo;yang tadi salah, harusnya 45rb&rdquo;) atau lewat dashboard.</li>
          <li><b>Menghapus data dan menarik persetujuan:</b> ketik <b>hapus data</b>. Kami kirim salinan datamu dulu, lalu menghapus semuanya setelah {graceDays} hari. Ketik <b>batal hapus</b> kalau berubah pikiran.</li>
          <li><b>Bertanya atau mengajukan keberatan:</b> hubungi kontak pelindungan data di bagian 1.</li>
        </ul>
        <p className="text-sm text-ink-3">
          Kalau kamu wajib pajak, simpan salinan pembukuanmu sendiri sebelum menghapus data. Catatan pembukuan umumnya wajib disimpan bertahun-tahun.
        </p>
      </Section>

      <Section title="9. Perubahan kebijakan">
        <p>Kalau kebijakan ini berubah, versinya ikut berubah. Untuk perubahan penting, kami akan minta persetujuanmu lagi lewat WhatsApp.</p>
      </Section>
    </main>
  );
}
