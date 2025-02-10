-- Duplication des fichiers pour les arrêtés qui pointent vers le même fichiers
-- Dans la nouvelle BDD -> 1 arrêté = 1 fichier
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 73424 ; UPDATE public.arrete_restriction as ar set "fichierId" = 73424
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73424 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73424 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 92704 ; UPDATE public.arrete_restriction as ar set "fichierId" = 92704
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 92704 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 92704 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 80411 ; UPDATE public.arrete_restriction as ar set "fichierId" = 80411
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 80411 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 80411 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 169041 ; UPDATE public.arrete_restriction as ar set "fichierId" = 169041
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 169041 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 169041 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 72977 ; UPDATE public.arrete_restriction as ar set "fichierId" = 72977
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 72977 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 72977 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 169499 ; UPDATE public.arrete_restriction as ar set "fichierId" = 169499
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 169499 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 169499 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 74426 ; UPDATE public.arrete_restriction as ar set "fichierId" = 74426
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 74426 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 74426 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 73264 ; UPDATE public.arrete_restriction as ar set "fichierId" = 73264
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73264 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73264 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 90623 ; UPDATE public.arrete_restriction as ar set "fichierId" = 90623
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 90623 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 90623 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 72978 ; UPDATE public.arrete_restriction as ar set "fichierId" = 72978
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 72978 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 72978 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 119554 ; UPDATE public.arrete_restriction as ar set "fichierId" = 119554
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 119554 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 119554 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 73232 ; UPDATE public.arrete_restriction as ar set "fichierId" = 73232
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73232 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73232 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 90621 ; UPDATE public.arrete_restriction as ar set "fichierId" = 90621
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 90621 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 90621 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 145176 ; UPDATE public.arrete_restriction as ar set "fichierId" = 145176
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 145176 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 145176 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 208074 ; UPDATE public.arrete_restriction as ar set "fichierId" = 208074
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 208074 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 208074 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 73211 ; UPDATE public.arrete_restriction as ar set "fichierId" = 73211
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73211 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73211 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 146525 ; UPDATE public.arrete_restriction as ar set "fichierId" = 146525
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 146525 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 146525 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 73402 ; UPDATE public.arrete_restriction as ar set "fichierId" = 73402
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73402 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73402 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 146523 ; UPDATE public.arrete_restriction as ar set "fichierId" = 146523
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 146523 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 146523 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 73473 ; UPDATE public.arrete_restriction as ar set "fichierId" = 73473
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73473 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73473 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 74609 ; UPDATE public.arrete_restriction as ar set "fichierId" = 74609
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 74609 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 74609 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 90624 ; UPDATE public.arrete_restriction as ar set "fichierId" = 90624
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 90624 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 90624 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 203986 ; UPDATE public.arrete_restriction as ar set "fichierId" = 203986
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 203986 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 203986 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 95777 ; UPDATE public.arrete_restriction as ar set "fichierId" = 95777
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 95777 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 95777 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 147389 ; UPDATE public.arrete_restriction as ar set "fichierId" = 147389
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 147389 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 147389 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 91608 ; UPDATE public.arrete_restriction as ar set "fichierId" = 91608
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 91608 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 91608 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 89927 ; UPDATE public.arrete_restriction as ar set "fichierId" = 89927
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 89927 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 89927 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 74284 ; UPDATE public.arrete_restriction as ar set "fichierId" = 74284
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 74284 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 74284 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 90625 ; UPDATE public.arrete_restriction as ar set "fichierId" = 90625
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 90625 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 90625 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 74327 ; UPDATE public.arrete_restriction as ar set "fichierId" = 74327
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 74327 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 74327 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 73142 ; UPDATE public.arrete_restriction as ar set "fichierId" = 73142
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73142 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73142 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 74264 ; UPDATE public.arrete_restriction as ar set "fichierId" = 74264
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 74264 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 74264 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 74264 ; UPDATE public.arrete_restriction as ar set "fichierId" = 74264
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 74264 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 74264 order by ppar.id_arrete DESC LIMIT 1 OFFSET 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 90632 ; UPDATE public.arrete_restriction as ar set "fichierId" = 90632
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 90632 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 90632 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 144815 ; UPDATE public.arrete_restriction as ar set "fichierId" = 144815
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 144815 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 144815 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 73157 ; UPDATE public.arrete_restriction as ar set "fichierId" = 73157
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73157 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73157 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 74603 ; UPDATE public.arrete_restriction as ar set "fichierId" = 74603
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 74603 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 74603 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 151155 ; UPDATE public.arrete_restriction as ar set "fichierId" = 151155
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 151155 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 151155 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 81257 ; UPDATE public.arrete_restriction as ar set "fichierId" = 81257
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 81257 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 81257 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 73289 ; UPDATE public.arrete_restriction as ar set "fichierId" = 73289
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73289 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73289 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 73341 ; UPDATE public.arrete_restriction as ar set "fichierId" = 73341
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73341 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73341 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 90630 ; UPDATE public.arrete_restriction as ar set "fichierId" = 90630
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 90630 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 90630 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 146268 ; UPDATE public.arrete_restriction as ar set "fichierId" = 146268
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 146268 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 146268 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 73246 ; UPDATE public.arrete_restriction as ar set "fichierId" = 73246
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73246 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73246 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 73276 ; UPDATE public.arrete_restriction as ar set "fichierId" = 73276
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73276 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73276 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 73482 ; UPDATE public.arrete_restriction as ar set "fichierId" = 73482
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73482 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73482 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 73004 ; UPDATE public.arrete_restriction as ar set "fichierId" = 73004
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73004 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73004 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 73277 ; UPDATE public.arrete_restriction as ar set "fichierId" = 73277
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73277 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73277 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 93615 ; UPDATE public.arrete_restriction as ar set "fichierId" = 93615
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 93615 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 93615 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 90631 ; UPDATE public.arrete_restriction as ar set "fichierId" = 90631
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 90631 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 90631 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 147388 ; UPDATE public.arrete_restriction as ar set "fichierId" = 147388
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 147388 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 147388 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 192739 ; UPDATE public.arrete_restriction as ar set "fichierId" = 192739
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 192739 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 192739 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 90635 ; UPDATE public.arrete_restriction as ar set "fichierId" = 90635
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 90635 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 90635 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 73025 ; UPDATE public.arrete_restriction as ar set "fichierId" = 73025
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73025 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73025 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 90633 ; UPDATE public.arrete_restriction as ar set "fichierId" = 90633
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 90633 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 90633 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 145177 ; UPDATE public.arrete_restriction as ar set "fichierId" = 145177
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 145177 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 145177 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 73129 ; UPDATE public.arrete_restriction as ar set "fichierId" = 73129
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73129 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73129 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 73081 ; UPDATE public.arrete_restriction as ar set "fichierId" = 73081
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73081 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73081 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 73031 ; UPDATE public.arrete_restriction as ar set "fichierId" = 73031
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73031 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73031 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 90627 ; UPDATE public.arrete_restriction as ar set "fichierId" = 90627
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 90627 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 90627 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 119842 ; UPDATE public.arrete_restriction as ar set "fichierId" = 119842
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 119842 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 119842 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 96190 ; UPDATE public.arrete_restriction as ar set "fichierId" = 96190
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 96190 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 96190 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 80152 ; UPDATE public.arrete_restriction as ar set "fichierId" = 80152
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 80152 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 80152 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 146760 ; UPDATE public.arrete_restriction as ar set "fichierId" = 146760
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 146760 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 146760 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 169012 ; UPDATE public.arrete_restriction as ar set "fichierId" = 169012
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 169012 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 169012 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 119041 ; UPDATE public.arrete_restriction as ar set "fichierId" = 119041
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 119041 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 119041 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 144956 ; UPDATE public.arrete_restriction as ar set "fichierId" = 144956
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 144956 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 144956 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 73278 ; UPDATE public.arrete_restriction as ar set "fichierId" = 73278
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73278 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73278 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 119568 ; UPDATE public.arrete_restriction as ar set "fichierId" = 119568
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 119568 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 119568 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 73084 ; UPDATE public.arrete_restriction as ar set "fichierId" = 73084
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73084 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73084 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 73392 ; UPDATE public.arrete_restriction as ar set "fichierId" = 73392
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73392 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73392 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 146133 ; UPDATE public.arrete_restriction as ar set "fichierId" = 146133
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 146133 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 146133 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 73088 ; UPDATE public.arrete_restriction as ar set "fichierId" = 73088
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73088 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73088 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 74414 ; UPDATE public.arrete_restriction as ar set "fichierId" = 74414
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 74414 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 74414 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 74399 ; UPDATE public.arrete_restriction as ar set "fichierId" = 74399
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 74399 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 74399 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 73332 ; UPDATE public.arrete_restriction as ar set "fichierId" = 73332
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73332 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73332 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 73332 ; UPDATE public.arrete_restriction as ar set "fichierId" = 73332
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73332 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73332 order by ppar.id_arrete DESC LIMIT 1 OFFSET 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 119900 ; UPDATE public.arrete_restriction as ar set "fichierId" = 119900
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 119900 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 119900 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 119901 ; UPDATE public.arrete_restriction as ar set "fichierId" = 119901
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 119901 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 119901 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 144303 ; UPDATE public.arrete_restriction as ar set "fichierId" = 144303
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 144303 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 144303 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 73309 ; UPDATE public.arrete_restriction as ar set "fichierId" = 73309
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73309 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73309 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 73236 ; UPDATE public.arrete_restriction as ar set "fichierId" = 73236
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73236 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73236 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 74022 ; UPDATE public.arrete_restriction as ar set "fichierId" = 74022
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 74022 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 74022 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 74341 ; UPDATE public.arrete_restriction as ar set "fichierId" = 74341
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 74341 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 74341 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 73216 ; UPDATE public.arrete_restriction as ar set "fichierId" = 73216
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73216 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73216 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 80420 ; UPDATE public.arrete_restriction as ar set "fichierId" = 80420
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 80420 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 80420 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 204213 ; UPDATE public.arrete_restriction as ar set "fichierId" = 204213
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 204213 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 204213 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 117465 ; UPDATE public.arrete_restriction as ar set "fichierId" = 117465
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 117465 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 117465 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 90626 ; UPDATE public.arrete_restriction as ar set "fichierId" = 90626
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 90626 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 90626 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 73184 ; UPDATE public.arrete_restriction as ar set "fichierId" = 73184
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73184 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73184 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 143974 ; UPDATE public.arrete_restriction as ar set "fichierId" = 143974
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 143974 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 143974 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 74318 ; UPDATE public.arrete_restriction as ar set "fichierId" = 74318
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 74318 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 74318 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 73399 ; UPDATE public.arrete_restriction as ar set "fichierId" = 73399
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73399 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73399 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 196105 ; UPDATE public.arrete_restriction as ar set "fichierId" = 196105
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 196105 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 196105 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 90622 ; UPDATE public.arrete_restriction as ar set "fichierId" = 90622
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 90622 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 90622 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 73323 ; UPDATE public.arrete_restriction as ar set "fichierId" = 73323
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73323 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73323 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 74389 ; UPDATE public.arrete_restriction as ar set "fichierId" = 74389
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 74389 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 74389 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 92703 ; UPDATE public.arrete_restriction as ar set "fichierId" = 92703
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 92703 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 92703 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 74281 ; UPDATE public.arrete_restriction as ar set "fichierId" = 74281
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 74281 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 74281 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 73180 ; UPDATE public.arrete_restriction as ar set "fichierId" = 73180
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73180 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73180 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 118659 ; UPDATE public.arrete_restriction as ar set "fichierId" = 118659
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 118659 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 118659 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 74511 ; UPDATE public.arrete_restriction as ar set "fichierId" = 74511
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 74511 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 74511 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 73369 ; UPDATE public.arrete_restriction as ar set "fichierId" = 73369
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73369 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73369 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 74637 ; UPDATE public.arrete_restriction as ar set "fichierId" = 74637
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 74637 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 74637 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 73013 ; UPDATE public.arrete_restriction as ar set "fichierId" = 73013
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73013 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73013 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 73249 ; UPDATE public.arrete_restriction as ar set "fichierId" = 73249
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73249 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73249 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 90629 ; UPDATE public.arrete_restriction as ar set "fichierId" = 90629
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 90629 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 90629 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 73385 ; UPDATE public.arrete_restriction as ar set "fichierId" = 73385
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73385 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73385 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 72983 ; UPDATE public.arrete_restriction as ar set "fichierId" = 72983
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 72983 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 72983 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 145457 ; UPDATE public.arrete_restriction as ar set "fichierId" = 145457
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 145457 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 145457 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 74614 ; UPDATE public.arrete_restriction as ar set "fichierId" = 74614
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 74614 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 74614 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 74614 ; UPDATE public.arrete_restriction as ar set "fichierId" = 74614
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 74614 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 74614 order by ppar.id_arrete DESC LIMIT 1 OFFSET 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 73072 ; UPDATE public.arrete_restriction as ar set "fichierId" = 73072
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73072 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73072 order by ppar.id_arrete DESC LIMIT 1);
INSERT INTO public.fichier (nom, size, url, created_at) SELECT nom, size, url, created_at from public.fichier where id = 73152 ; UPDATE public.arrete_restriction as ar set "fichierId" = 73152
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73152 order by ppar.id_arrete ASC LIMIT 1); UPDATE public.arrete_restriction as ar set "fichierId" = (select MAX(f.id) from public.fichier as f)
where ar.id = (SELECT ppar.id_arrete FROM talend_ingestion_ppluvia.arretes as ppar where ppar.fd_cdn = 73152 order by ppar.id_arrete DESC LIMIT 1);
