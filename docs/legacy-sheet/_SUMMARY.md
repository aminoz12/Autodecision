# Legacy Google Sheet — structure map

Source: `SUIVI DES VENTES & DEVIS.xlsx` — 9 tabs


## BASE DE DONNEE
- size: 640 rows x 30 cols
- detected header row: 5
- columns: ['B=DATE DE COMMANDE', 'C=REF DEMANDE', 'D=VENDEUR', 'E=CANAL DE VENTE', 'F=CLIENT', 'G=TÉLÉPHONE', 'H=EMAIL', 'I=IMMATRICULATION', 'J=MODÈLE VÉHICULE', 'K=NOM DU PRODUIT / PIÈCE', 'L=RÉF', 'M=À COMMANDER POUR LIVREUR ?', 'N=FOURNISSEUR', 'O=QTÉ', "P=PRIX D'ACHAT UNITAIRE (€)", 'Q=PRIX DE VENTE UNITAIRE (€)', 'R=MONTANT TOTAL TTC (€)', 'S=DEVIS ?', 'T=STATUT DE PAIEMENT', 'U=MONTANT PAYÉ (€)', 'V=AVANCE PAYÉE (€)\t', 'W=SOLDE RESTANT (€)', 'X=ENVOYER AU LIVREUR', "Y=DATE D'ENVOI AU LIVREUR", 'Z=STATUT LIVREUR', 'AA=ENVOYER', 'AB=STATUT', 'AC=BL', 'AD=DATE DE BL']
- sample rows:
    - {'B': datetime.datetime(2026, 3, 25, 0, 0), 'C': 'DMND/2503/9872', 'D': 'MHAMED', 'E': 'COMPTOIR', 'F': 'moh', 'G': 668784588.0, 'I': 'DP449DS', 'J': 'SMART', 'K': 'EMETTEUR', 'L': 'EE5125', 'M': '🛒 À commander', 'N': 'MGA', 'O': 1.0, 'P': 23.0, 'Q': 60.0, 'T': 'PAYE', 'AB': 'ENCAISSER'}
    - {'B': datetime.datetime(2026, 3, 28, 0, 0), 'C': 'DMND/2803/3586', 'D': 'MHAMED', 'E': 'COMPTOIR', 'F': 'hamza', 'L': 'elh4392', 'M': '✅ Disponible en stock', 'N': 'ACR', 'O': 1.0, 'Q': 10.0, 'T': 'PAYE', 'AB': 'ENCAISSER'}
    - {'S': False, 'X': False, 'AA': False, 'AC': False}
- formula columns:
    - E: ="Aujourd'hui le " & UPPER(LEFT(TEXT(TODAY(), "dddd"),1)) & RIGHT(TEXT(TODAY(), "dddd"),LEN(TEXT(TODAY(), "dddd"))-1) & " " & TEXT(TODAY(), "dd/mm/yyyy") 
    - R: =IF(COUNTIF(S6:S640,TRUE())=0, "Rien sélectionné", IF(COUNTIF(S6:S640,TRUE())=1, "1 Devis", COUNTIF(S6:S640,TRUE()) & " Devis")) 
    - U: =IF(T489="PAYE", R489, IF(T489="NON PAYE", -R489, IF(T489="EN COMPTE", -R489, IF(T489="AVANCE", "", ""))))
    - W: =IF(T489<>"AVANCE","",V489-R489)
    - Z: [IMPORTRANGE to external sheet]

## RETOUR AU STOCK
- size: 110 rows x 8 cols
- detected header row: 4
- columns: ['B=REF DEMANDE', 'C=NOM DU PRODUIT / PIÈCE', 'D=FOURNISSEUR', 'E=RÉF', 'F=STATUT STOCK', "G=DATE D'ENVOI AU LIVREUR", 'H=STATUT LIVREUR']
- sample rows:
    - {'B': 'DMND/2803/3586', 'D': 'ACR', 'E': 'elh4392', 'F': '🛒 COMMANDE', 'G': 'sam 28/03/26 à 23:12'}
- formula columns:
    - E: =IF(COUNTIFS(RETOUR_AU_STOCK[RÉF],"*",RETOUR_AU_STOCK[STATUT STOCK],"")>=1,COUNTIFS(RETOUR_AU_STOCK[RÉF],"*",RETOUR_AU_STOCK[STATUT STOCK],"")&" COMMANDES EN INSTANCE","AUCUNE COMMANDES EN INSTANCE")

## RECEPTION DES COMMANDES
- size: 695 rows x 19 cols
- detected header row: 4
- columns: ['B=DATE DE LIVRAISON', 'C=REF DEMANDE', 'D=VENDEUR', 'E=FOURNISSEUR', 'F=NOM DU PRODUIT / PIÈCE', 'G=RÉF', 'H=QTÉ', 'I=TYPE DE COMMANDE', 'J=STATUT COMMANDE', 'K=MOTIF RETOUR', 'L=ENVOYE SUR FEUILLE\nRETOUR', 'M=DATE RETOUR', 'N=ENVOYE SUR FEUILLE AVOIR', 'O=DATE AVOIR', 'P=SMS', 'Q=SMS\nARRIVÉ DE LA PIÈCE AU MAGASIN', 'R=COMMANDE CLOTUREE', 'S=SMS RAPPEL\n+ 7 JOURS (AUTOMATIQUE)']
- sample rows:
    - {'B': datetime.datetime(2025, 7, 2, 0, 0), 'C': 'DMND/0207/3656', 'D': 'MHAMED', 'E': 'ACR', 'F': 'DEMARREUR', 'G': '3102 = SBO1217', 'H': 1.0, 'I': 'RETOUR AU STOCK', 'J': 'RECU', 'L': False, 'N': False, 'P': False, 'R': True}
    - {'B': datetime.datetime(2025, 7, 4, 0, 0), 'C': 'DMND/0207/6616', 'D': 'MHAMED', 'E': 'AP', 'F': 'SUPPORT MOTEUR', 'G': '2700052 = 40-0368', 'H': 1.0, 'I': 'RETOUR AU STOCK', 'J': 'RECU', 'L': False, 'N': False, 'P': False, 'R': True}
    - {'B': datetime.datetime(2025, 7, 4, 0, 0), 'C': 'DMND/0207/5299', 'D': 'MHAMED', 'E': 'AP', 'F': 'POMPE A EAU', 'G': 'WP2604 = MGC-6971', 'H': 1.0, 'I': 'RETOUR AU STOCK', 'J': 'RECU', 'L': False, 'N': False, 'P': False, 'R': True}
- formula columns:
    - I: =IF(COUNTIFS(RECEPTION[TYPE DE COMMANDE],"*",RECEPTION[STATUT COMMANDE],"")=0,"Aucune commande en instance",COUNTIFS(RECEPTION[TYPE DE COMMANDE],"*",RECEPTION[STATUT COMMANDE],"")&" Commandes en insta
    - L: =IF(COUNTIF(RECEPTION[MOTIF RETOUR],"*")=0,"PAS DE RETOUR","Le taux actuel du retour est "&TEXT(COUNTIF(RECEPTION[MOTIF RETOUR],"*")/COUNTIF(RECEPTION[TYPE DE COMMANDE],"*")*100,"0")&" %") 

## RETOUR
- size: 13 rows x 15 cols
- detected header row: 4
- columns: ['B=DATE DE COMMANDE', 'C=REF DEMANDE', 'D=VENDEUR', 'E=FOURNISSEUR', 'F=NOM DU PRODUIT / PIÈCE', 'G=RÉF', 'H=QTÉ', 'I=DATE DE RETOUR', 'J=MOTIF RETOUR', 'K=TRAITEE OU PAS', 'L=DATE TRAITEMENT', 'M=STATUT CHAUFFEUR', 'N=DATE DE DÉPÔT', 'O=MOTIF SI REFUS']
- sample rows:
    - {'B': datetime.datetime(2025, 7, 2, 0, 0), 'C': 'DMND/0207/5700', 'D': 'AYOUB', 'E': 'OTTOGO', 'F': 'DISTRIBUTION', 'H': 1.0, 'I': 'mer 02/07/25 à 14:38', 'J': 'Erreur magasin', 'K': 'OK', 'L': 'mer 02/07/25 à 14:44'}
    - {'B': datetime.datetime(2025, 7, 7, 0, 0), 'C': 'DMND/0407/8905', 'D': 'ABDELLAH', 'E': 'PSH', 'F': 'AMORTISSEUR ', 'H': 1.0, 'I': 'ven 04/07/25 à 16:37', 'J': 'Garantie', 'K': 'OK', 'L': 'ven 04/07/25 à 16:37'}
    - {'B': datetime.datetime(2025, 7, 4, 0, 0), 'C': 'DMND/0407/8202', 'D': 'MHAMED', 'E': 'ACR', 'F': 'KIT EMBRAYAGE', 'G': 623353400.0, 'H': 1.0, 'I': 'sam 05/07/25 à 10:26', 'J': 'Autre', 'K': 'OK', 'L': 'sam 05/07/25 à 10:28'}
- formula columns:
    - G: ="Aujourd'hui le " & UPPER(LEFT(TEXT(TODAY(), "dddd"),1)) & RIGHT(TEXT(TODAY(), "dddd"),LEN(TEXT(TODAY(), "dddd"))-1) & " " & TEXT(TODAY(), "dd/mm/yyyy") 
    - M: [IMPORTRANGE to external sheet]
    - N: [IMPORTRANGE to external sheet]
    - O: [IMPORTRANGE to external sheet]

## AVOIR
- size: 1013 rows x 12 cols
- detected header row: 4
- columns: ['B=DATE DE COMMANDE', 'C=REF DEMANDE', 'D=CLIENT', 'E=TÉLÉPHONE', 'F=EMAIL', 'G=IMMATRICULATION', "H=DATE DE BON D'ACHAT", "I=VALABLE JUSQU'AU", 'J=MONTANT DE LA COMMANDE', 'K=MONTANT UTILISE', 'L=RESTE DU MONTANT']
- sample rows:
    - {'J': 100.0, 'K': 90.0}
    - {'J': 100.0, 'K': 90.0, 'L': -10}
    - {'B': datetime.datetime(2025, 7, 7, 0, 0), 'C': 'DMND/0407/8905', 'D': 'MITHULAN BASKARAN', 'E': 783097540.0, 'H': datetime.datetime(2025, 7, 7, 0, 0), 'I': datetime.datetime(2026, 7, 7, 0, 0), 'J': 780.0, 'L': -780}
- formula columns:
    - G: ="Aujourd'hui le " & UPPER(LEFT(TEXT(TODAY(), "dddd"),1)) & RIGHT(TEXT(TODAY(), "dddd"),LEN(TEXT(TODAY(), "dddd"))-1) & " " & TEXT(TODAY(), "dd/mm/yyyy") 
    - L: =IF(J6="","",K6-J6)

## CONSIGNE
- size: 6 rows x 11 cols
- detected header row: 4
- columns: ['B=DATE DE COMMANDE', 'C=REF DEMANDE', 'D=VENDEUR', 'E=CLIENT', 'F=RÉF', 'G=IMMATRICULATION', 'H=FOURNISSEUR', 'I=MONTANT DE LA CONSIGNE', 'J=STATUT CONSIGNE', 'K=DATE DE CONSIGNE RENDU']
- sample rows:
    - {'J': True, 'K': 'sam 28/03/26 à 23:48'}
    - {'J': True, 'K': 'lun 22/06/26 à 00:38'}
- formula columns:
    - E: ="Aujourd'hui le " & UPPER(LEFT(TEXT(TODAY(), "dddd"),1)) & RIGHT(TEXT(TODAY(), "dddd"),LEN(TEXT(TODAY(), "dddd"))-1) & " " & TEXT(TODAY(), "dd/mm/yyyy") 

## BON DE LIVRAISON
- size: 42 rows x 19 cols
- detected header row: 2
- columns: ['B=ESPACE AUTO 92', 'I=BL NR :', 'J=BL/200525/307']
- sample rows:
    - {'B': '426 Av. de la République, \n92000 Nanterre, France', 'I': 'DATE :', 'J': datetime.datetime(2025, 5, 20, 0, 0)}
    - {'B': 'Téléphone : +33 1 47 85 10 00'}
    - {'B': 'Email :'}

## DEVIS
- size: 1000 rows x 18 cols
- detected header row: 11
- columns: ['B=NR', 'C=REF DEMANDE', 'D=REF ARTICLE', 'E=DESIGNATION ARTICLE', 'I=PU HT', 'J=%', 'K=QUANTITE', 'L=TOT. HT', 'M=TOT TTC']
- sample rows:
    - {'B': 1.0, 'C': 'DMND/2905/9553', 'D': 'MA555', 'E': 'BATTERIE', 'I': 11000.0, 'K': 1.0, 'L': 11000.0, 'M': 13200}
    - {'I': 'TOTAL', 'K': 1, 'L': 11000, 'M': 13200}
    - {'J': 'Cachet et Signature'}
- formula columns:
    - L: =TODAY()
    - M: =IF(ISBLANK(I12),"",L12*1.2)
    - K: =SUM(K12:K18)

## Historique des événements
- size: 1000 rows x 26 cols
- detected header row: 5
- columns: ['B=DATE', 'C=N° DE DEVIS', 'D=N° DEMANDE', 'E=VENDEUR', 'F=EMIS PAR', 'G=POUR']
- sample rows:
    - {'B': datetime.datetime(2025, 4, 20, 0, 0), 'C': 'DEVIS/200425/436', 'D': 'DMND/70578', 'E': 'GOKAN', 'F': 'hamzza.me@gmail.com', 'G': 'HAMZA AB'}
    - {'B': datetime.datetime(2025, 4, 20, 0, 0), 'C': 'DEVIS/200425/436', 'D': 'DMND/43191', 'E': 'AYOUB', 'F': 'hamzza.me@gmail.com', 'G': 'HAMZA AB'}
    - {'B': datetime.datetime(2025, 4, 18, 0, 0), 'C': 'DEVIS/200425/083', 'D': 'DMND/88134', 'E': 'ABDELLAH', 'F': 'hamzza.me@gmail.com', 'G': 'HAMZA'}