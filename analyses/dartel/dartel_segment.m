function dartel_segment(t1, mask, spmdir)
% Reorient one brain-cropped T1 so that its origin lies near the anterior
% commissure, then run SPM 25 unified segmentation with the default tissue
% probability maps.
%
% t1     : Working copy <work>/seg/<id>/<id>_T1w.nii (its header is changed;
%          the voxel data are not resampled).
% mask   : Brain mask of the T1 (any grid; only its world centroid is used).
% spmdir : SPM 25 folder.
%
% Reorientation: translate the brain-mask centroid to the brain centroid of
% tpm/TPM.nii, then rigid NMI coregistration to canonical/avg152T1. The
% transform is saved in reorient.mat, and a rerun restarts from the scanner
% header. Outputs beside t1: c1-c3 (native), rc1-rc2 (DARTEL imported),
% m<id>_T1w (bias corrected, for QC montages), <id>_T1w_seg8.mat, SEG_DONE.
addpath(spmdir);
spm('defaults', 'PET');
spm_jobman('initcfg');
spm_get_defaults('cmdline', true);
t0   = tic;
sdir = fileparts(t1);
reo  = fullfile(sdir, 'reorient.mat');

% ---- Reorientation (header only) ---------------------------------------
if exist(reo, 'file')
    S = load(reo); orig = S.orig;
    spm_get_space(t1, orig);
else
    orig = spm_get_space(t1);
end
Vm = spm_vol(mask);
m  = spm_read_vols(Vm) > 0;
[i, j, k] = ind2sub(size(m), find(m));
c  = Vm.mat * [mean(i); mean(j); mean(k); 1];
target = [0.5; -20; 9];                   % GM+WM+CSF centroid of tpm/TPM.nii, MNI mm.
T  = spm_matrix((target - c(1:3))');
spm_get_space(t1, T * orig);
VG = spm_vol(fullfile(spmdir, 'canonical', 'avg152T1.nii'));
VF = spm_vol(t1);
x  = spm_coreg(VG, VF, struct('cost_fun', 'nmi', 'sep', [4 2], 'fwhm', [7 7]));
spm_get_space(t1, spm_matrix(x) \ spm_get_space(t1));
newmat = spm_get_space(t1);
cnew   = newmat * (orig \ c);             % Brain centroid after reorientation.
save(reo, 'orig', 'T', 'x', 'newmat', 'c', 'cnew');
t_reo = toc(t0);

% ---- Segment -----------------------------------------------------------
for pre = {'c1', 'c2', 'c3', 'rc1', 'rc2'}   % Outputs of an earlier run.
    old = dir(fullfile(sdir, [pre{1} '*.nii'])); for q = 1:numel(old), delete(fullfile(sdir, old(q).name)); end
end
tpm   = fullfile(spmdir, 'tpm', 'TPM.nii');
ngaus = [1 1 2 3 4 2];
nat   = {[1 1], [1 1], [1 0], [0 0], [0 0], [0 0]};
p = struct();
p.channel.vols     = {[t1 ',1']};
p.channel.biasreg  = 0.0001;              % SPM 25 menu label: "light regularisation".
p.channel.biasfwhm = 60;
p.channel.write    = [0 1];               % Bias-corrected image for QC montages.
for q = 1:6
    p.tissue(q).tpm    = {[tpm ',' num2str(q)]};
    p.tissue(q).ngaus  = ngaus(q);
    p.tissue(q).native = nat{q};
    p.tissue(q).warped = [0 0];
end
p.warp.mrf     = 1;
p.warp.cleanup = 1;
p.warp.reg     = [0 0 0.1 0.01 0.04];
p.warp.affreg  = 'mni';
p.warp.fwhm    = 0;
p.warp.samp    = 3;
p.warp.write   = [0 0];
p.warp.vox     = NaN;
p.warp.bb      = [NaN NaN NaN; NaN NaN NaN];
matlabbatch{1}.spm.spatial.preproc = p;
spm_jobman('run', matlabbatch);
t_all = toc(t0);
fid = fopen(fullfile(sdir, 'SEG_DONE'), 'w');
fprintf(fid, '%.1f\t%.1f\t%.2f %.2f %.2f %.2f %.2f %.2f\n', t_reo, t_all, x(1:3), x(4:6) * 180 / pi);
fclose(fid);
fprintf('Segment done: reorientation %.1f s, total %.1f s, rotation [%.1f %.1f %.1f] deg.\n', t_reo, t_all, x(4:6) * 180 / pi);
end
