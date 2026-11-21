# KillerTab

![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=181818)
![HTML5](https://img.shields.io/badge/HTML5-C03919?style=for-the-badge&logo=html5&logoColor=white)
![CSS](https://img.shields.io/badge/CSS-663399?style=for-the-badge&logo=css&logoColor=white)
[![Versi KillerTab 1.3.0](https://img.shields.io/badge/Versi-v1.3.0-245844?style=for-the-badge)](./manifest.json)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-344563?style=for-the-badge&logo=googlechrome&logoColor=white)

Ekstensi Manifest V3 untuk Chrome, Brave, dan browser Chromium yang kompatibel (Chromium 121+). Dibuat oleh **Akira Keiji** dengan JavaScript dan CSS tanpa dependensi.

## Pasang

1. Di GitHub, pilih **Code → Download ZIP**, lalu ekstrak.
2. Buka `chrome://extensions/` di Chrome atau `brave://extensions/` di Brave.
3. Aktifkan **Developer mode**, klik **Load unpacked**, lalu pilih folder hasil ekstrak yang berisi `manifest.json`.
4. Buka KillerTab dari toolbar. Pilih durasi dan nyalakan **Tidur otomatis** jika dibutuhkan.

Jika sudah memakai Tab Hening, salin isi folder hasil ekstrak ke folder ekstensi lama, termasuk folder `icons` dan `rules`. Klik **Reload** di halaman ekstensi. Pengaturan lama mengikuti instalasi di folder yang sama. Setujui izin pemblokiran iklan jika diminta.

## Cara pakai

- Pilih **Langsung**, **5 menit**, **15 menit**, atau **30 menit**. Antrean muncul saat tidur otomatis aktif dan menampilkan hitung mundur untuk tab latar yang paling dekat dengan batas waktunya. Chromium bisa menunda alarm, misalnya saat laptop tidur.
- **Tidurkan sekarang** menidurkan hingga delapan tab latar yang memenuhi syarat di jendela yang terakhir kamu gunakan. Bisa dijalankan saat tidur otomatis dijeda atau dimatikan.
- **Khusus tab duplikat** mencari URL yang sama persis di jendela itu. Satu salinan tetap dimuat. Tab aktif atau tab yang dilindungi diprioritaskan sebagai salinan yang tetap berjalan.
- Di **Jeda & situs**, kamu bisa menjeda tidur otomatis selama 30 menit atau melanjutkannya kapan saja. Setelah lanjut, hitung mundur tab yang masih terbuka dimulai ulang. Tambahkan domain atau URL untuk melindungi situs dan subdomainnya dari peniduran manual maupun otomatis oleh KillerTab.
- Tab tidur tetap tercantum di bilah tab dan dimuat ulang saat dibuka. Untuk menyimpan draf, pemutaran yang dibisukan, atau pekerjaan di halaman penting, simpan perubahan dan sematkan tabnya.
- Tab aktif di setiap jendela, tab yang disematkan, tab yang terdengar memutar audio, tab yang sedang dimuat, halaman internal, dan tab yang ditandai tak boleh dibuang oleh browser dilewati.
- **Tab terbuka** menampilkan jumlah tab di profil normal, termasuk jumlah yang sedang tidur. Klik nama tab untuk membukanya. Hitungan tidur dapat mencakup tab yang dibuang oleh penghemat memori bawaan.
- **Ekstensi** membaca nama dan status ekstensi terpasang setelah kamu memberikan izin opsional. Fitur tidur otomatis tetap bisa dipakai tanpa izin ini. Izin dapat ditarik lewat opsi izin situs/ekstensi jika tersedia di browser, atau dengan memasang ulang ekstensi.
- Persentase RAM dan CPU mengukur beban seluruh sistem. Mode **Live** memperbarui meter setiap lima detik selama panel utama terlihat. Matikan **Live**, lalu klik **Ukur** untuk mengambil satu sampel saat dibutuhkan.
- Mesin tidur otomatis bergerak saat ada perubahan tab atau alarm. Sampai empat tab diproses per putaran otomatis dengan jeda minimal 30 detik jika masih ada antrean yang siap.
- Gunakan **Alt + Shift + K** untuk membuka popup jika shortcut tersedia. Sesuaikan di menu **Keyboard shortcuts** pada halaman ekstensi.

## Blokir iklan

Adblock aktif secara default. Aturan bawaan Chromium memblokir permintaan sumber daya pihak ketiga ke daftar domain jaringan iklan yang disertakan di ZIP. Cakupannya berfokus pada jaringan tersebut. Iklan yang dikirim langsung dari situs, iklan di dalam aliran video, dan elemen sisa iklan di halaman bisa tetap terlihat.

Buka tab situs yang perlu dikecualikan, lalu pilih **Pengecualian situs** di KillerTab. Setelah menambah atau menghapus pengecualian, muat ulang halaman. Pengecualian mencakup subdomain dan hanya berlaku untuk pemblokiran oleh KillerTab.

Semua pemrosesan berjalan di browser. Pengaturan disimpan secara lokal dan timer tab disimpan selama sesi. KillerTab tidak memuat skrip eksternal, menyuntikkan skrip ke situs, atau mengirim data ke server.
